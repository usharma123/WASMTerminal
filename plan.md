     # Linux/Wasm Memory Isolation - Implementation Plan
     
     ## Goal
     Implement per-process memory isolation with minimal performance overhead using
     separate WebAssembly.Memory instances per process.
     
     ## Current State
     - Single shared `WebAssembly.Memory` for all processes
     - No MMU, flat 32-bit address space
     - All tasks can read/write any memory (no isolation)
     - Cooperative scheduling only (no preemption)
     
     ## Proposed Solution
     **Per-Process Wasm Memory Instances** - Each user process gets its own Memory
     instance, providing hardware-enforced isolation via Wasm sandbox.
     
     ### Why This Approach?
     - **Zero per-access overhead** - No runtime bounds checking
     - **Hardware isolation** - Wasm sandbox enforces memory boundaries
     - **Syscall copy only** - Data copied at syscall boundaries (~1-5μs overhead)
     - **Performance first** - For 1000 syscalls/sec: ~0.5% CPU overhead
     
     ---
     
     ## Architecture
     
     ```
     KERNEL MEMORY (SharedArrayBuffer, shared across all workers):
     +------------------+
     |  Kernel code     |  vmlinux.wasm
     |  Kernel data     |
     |  task_struct[]   |  Per-task kernel data
     |  Syscall buffers |  Scratch space for user data copies
     +------------------+
     
     USER MEMORY (separate WebAssembly.Memory per process):
     +------------------+
     |  User code       |  .wasm binary
     |  User data       |
     |  User stack      |
     |  User heap       |
     +------------------+
     ```
     
     ---
     
     ## Phase 1: JavaScript Runtime Changes
     
     ### 1.1 Modify `site/linux.js`
     
     **Add memory management:**
     ```javascript
     // Separate kernel and user memories
     const kernel_memory = new WebAssembly.Memory({
       initial: 30, maximum: 0x10000, shared: true
     });
     
     const user_memories = new Map();  // task_ptr -> Memory
     
     const create_user_memory = (task_ptr, initial_pages) => {
       const mem = new WebAssembly.Memory({
         initial: initial_pages,
         maximum: 0x10000,
         shared: false
       });
       user_memories.set(task_ptr, mem);
       return mem;
     };
     ```
     
     **Modify `make_task()`:**
     - Create isolated user memory for each new process
     - Pass user_memory to worker via postMessage
     
     ### 1.2 Modify `site/linux-worker.js`
     
     **Add dual memory tracking:**
     ```javascript
     let kernel_memory = null;  // Shared
     let user_memory = null;    // Per-process (null for kthreads)
     ```
     
     **Modify user executable imports:**
     - Use `user_memory` instead of shared memory
     - Wrap syscalls with copy functions
     
     ### 1.3 New: Syscall Copy Functions
     
     ```javascript
     const SYSCALL_BUFFER_SIZE = 64 * 1024;
     
     const copy_from_user = (user_ptr, size) => {
       const user_view = new Uint8Array(user_memory.buffer, user_ptr, size);
       const kernel_view = new Uint8Array(kernel_memory.buffer, syscall_buffer_ptr,
     size);
       kernel_view.set(user_view);
       return syscall_buffer_ptr;
     };
     
     const copy_to_user = (user_ptr, kernel_ptr, size) => {
       const kernel_view = new Uint8Array(kernel_memory.buffer, kernel_ptr, size);
       const user_view = new Uint8Array(user_memory.buffer, user_ptr, size);
       user_view.set(kernel_view);
     };
     ```
     
     ---
     
     ## Phase 2: Syscall Pointer Translation
     
     ### 2.1 Create Syscall Pointer Map
     
     Map each syscall to its pointer arguments:
     ```javascript
     const SYSCALL_POINTER_MAP = {
       [SYS_read]:   { out: [1], sizes: [2] },       // buf is output
       [SYS_write]:  { in: [1], sizes: [2] },        // buf is input
       [SYS_openat]: { in: [1], string: true },      // path is string
       [SYS_statx]:  { in: [1], out: [4] },          // path in, statbuf out
       // ... complete for all pointer syscalls
     };
     ```
     
     ### 2.2 Generic Translation Logic
     
     ```javascript
     const translate_syscall = (nr, ...args) => {
       const map = SYSCALL_POINTER_MAP[nr];
       if (!map) return direct_syscall(nr, ...args);
     
       // Copy inputs from user to kernel
       // Make syscall with kernel pointers
       // Copy outputs from kernel to user
       return result;
     };
     ```
     
     ---
     
     ## Phase 3: Kernel Modifications
     
     ### 3.1 Modify `binfmt_wasm.c`
     - Don't map user data in kernel memory
     - Report required sizes to host
     - Host creates user memory with appropriate size
     
     ### 3.2 Add to `thread_info.h`
     ```c
     #define TIF_ISOLATED_MEMORY 10
     ```
     
     ### 3.3 Memory operations (brk/mmap)
     - Redirect to user memory instead of shared memory
     - Track allocations per-process
     
     ---
     
     ## Phase 4: Clone/Fork Handling
     
     **Without CLONE_VM (fork):**
     ```javascript
     // Create new memory, copy parent contents
     const child_mem = create_user_memory(new_task, parent_pages);
     new Uint8Array(child_mem.buffer).set(new Uint8Array(parent_mem.buffer));
     ```
     
     **With CLONE_VM (threads):**
     ```javascript
     // Share memory with parent
     user_memories.set(new_task, parent_mem);
     ```
     
     ---
     
     ## Implementation Sequence
     
     ### Week 1: JavaScript Infrastructure
     - [ ] Dual memory management in linux.js
     - [ ] Worker modifications for separate memories
     - [ ] Basic syscall buffer allocation
     
     ### Week 2: Syscall Translation
     - [ ] Complete syscall pointer map
     - [ ] Implement copy_from_user/copy_to_user
     - [ ] Handle string arguments (paths)
     
     ### Week 3: Kernel Modifications
     - [ ] Modify binfmt_wasm.c
     - [ ] Add task-local syscall buffers
     - [ ] Update thread_info flags
     
     ### Week 4: Memory Operations
     - [ ] brk/mmap in user memory
     - [ ] Fork/clone memory handling
     - [ ] Exec memory replacement
     
     ### Week 5: Testing
     - [ ] Syscall correctness tests
     - [ ] Memory isolation verification
     - [ ] Performance benchmarking
     
     ---
     
     ## Critical Files
     
     | File | Changes |
     |------|---------|
     | `site/linux.js` | Memory management, task creation |
     | `site/linux-worker.js` | Dual memory, syscall translation |
     | `linux-wasm/patches/kernel/binfmt_wasm.c` | Binary loading |
     | `linux-wasm/patches/kernel/thread_info.h` | Isolation flags |
     
     ---
     
     ## Risks & Mitigations
     
     | Risk | Mitigation |
     |------|------------|
     | Browser limits (~100-1000 Memory instances) | Process pooling, reuse memories
     |
     | Syscall copy overhead | Batch copies, typed arrays |
     | Pointer validation bugs | Comprehensive syscall testing |
     | Thread memory sharing | CLONE_VM shares, others copy |
     
     ---
     
     ## Performance Estimate
     
     - **Per-access overhead:** 0 (native Wasm speed)
     - **Syscall overhead:** ~1-5μs for copy
     - **1000 syscalls/sec:** ~5ms total (~0.5% CPU)
     - **Result:** Isolation with minimal performance impact
     
     
     "/plan open" to edit this plan in Vim