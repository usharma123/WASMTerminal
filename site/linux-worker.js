// SPDX-License-Identifier: GPL-2.0-only

(function (console) {
  let port = self;
  let memory = null;  // Kernel memory (shared). Note: memory.buffer has to be re-accessed after growing!
  let user_memory = null;  // User memory (isolated, non-shared). Null for kernel threads.
  let syscall_buffer_offset = null;  // Offset into kernel memory for syscall data copying
  let syscall_buffer_size = 0;  // Size of syscall buffer
  let locks = null;
  const text_decoder = new TextDecoder("utf-8");
  const text_encoder = new TextEncoder();

  /// A string denoting the runner name (same as Worker name), useful for debugging.
  let runner_name = "[Unknown]";

  /// SAB-backed storage for last process in switch_to (when it returns back from another task).
  let switch_to_last_task = null;

  /// The vmlinux instance, to handle boot, idle, kthreads and syscalls etc.
  let vmlinux_instance = null;

  /// The user executable (if any) to run when we're not in vmlinux.
  let user_executable = null;
  let user_executable_params = null;

  /// The user executabe instance, or null. Try using the instance variable in the promise over this one if possible.
  let user_executable_instance = null;
  let user_executable_imports = null;

  /// Flag that a clone callback should be called instead of _start().
  let should_call_clone_callback = false;

  /// A messenger to synchronize with the main thread, as well as communicate how many bytes were read on the console.
  let console_read_messenger = new Int32Array(new SharedArrayBuffer(4));

  /// A messenger for network operations. Format: [status, result/error]
  let net_messenger = new Int32Array(new SharedArrayBuffer(8));

  /// A messenger for filesystem operations. Format: [status, result/error]
  let fs_messenger = new Int32Array(new SharedArrayBuffer(8));

  /// An exception type used to abort part of execution (useful for collapsing the call stack of user code).
  class Trap extends Error {
    constructor(kind) {
      super("This exception should be ignored. It is part of Linux/Wasm host glue.");
      Error.captureStackTrace && Error.captureStackTrace(this, Trap);
      this.name = "Trap";
      this.kind = kind;
    }
  }

  const log = (message) => {
    port.postMessage({
      method: "log",
      message: "[Runner " + runner_name + "]: " + message,
    });
  };

  /// Get a JS string object from a (nul-terminated) C-string in a Uint8Array.
  const get_cstring = (memory, index) => {
    const memory_u8 = new Uint8Array(memory.buffer);
    let end;
    for (end = index; memory_u8[end]; ++end); // Find terminating nul-character.
    return text_decoder.decode(memory_u8.slice(index, end));
  };

  // ============================================================================
  // Memory Isolation - Syscall Copy Functions
  // ============================================================================

  /**
   * Copy data from user memory to kernel syscall buffer.
   * Used for syscall inputs (e.g., write() buffer, path strings).
   * @param {number} user_ptr - Pointer in user memory
   * @param {number} size - Number of bytes to copy
   * @returns {number} Pointer to data in kernel memory (syscall buffer)
   */
  const copy_from_user = (user_ptr, size) => {
    if (!user_memory || !syscall_buffer_offset) {
      // No isolation - return original pointer (legacy mode)
      return user_ptr;
    }

    if (size > syscall_buffer_size) {
      throw new Error(`copy_from_user: size ${size} exceeds buffer ${syscall_buffer_size}`);
    }

    const user_view = new Uint8Array(user_memory.buffer, user_ptr, size);
    const kernel_view = new Uint8Array(memory.buffer, syscall_buffer_offset, size);
    kernel_view.set(user_view);

    return syscall_buffer_offset;
  };

  /**
   * Copy data from kernel memory to user memory.
   * Used for syscall outputs (e.g., read() buffer, stat structures).
   * @param {number} user_ptr - Destination pointer in user memory
   * @param {number} kernel_ptr - Source pointer in kernel memory
   * @param {number} size - Number of bytes to copy
   */
  const copy_to_user = (user_ptr, kernel_ptr, size) => {
    if (!user_memory) {
      // No isolation - do nothing (data is already in shared memory)
      return;
    }

    const kernel_view = new Uint8Array(memory.buffer, kernel_ptr, size);
    const user_view = new Uint8Array(user_memory.buffer, user_ptr, size);
    user_view.set(kernel_view);
  };

  /**
   * Copy a null-terminated string from user memory to kernel syscall buffer.
   * @param {number} user_ptr - Pointer to string in user memory
   * @returns {number} Pointer to string in kernel memory
   */
  const copy_string_from_user = (user_ptr) => {
    if (!user_memory || !syscall_buffer_offset) {
      return user_ptr;
    }

    const user_u8 = new Uint8Array(user_memory.buffer);
    let end = user_ptr;
    while (user_u8[end]) end++;  // Find null terminator
    const len = end - user_ptr + 1;  // Include null terminator

    if (len > syscall_buffer_size) {
      throw new Error(`copy_string_from_user: string too long (${len} bytes)`);
    }

    const user_view = new Uint8Array(user_memory.buffer, user_ptr, len);
    const kernel_view = new Uint8Array(memory.buffer, syscall_buffer_offset, len);
    kernel_view.set(user_view);

    return syscall_buffer_offset;
  };

  /**
   * Get user memory for the current task (or kernel memory if no isolation).
   * @returns {WebAssembly.Memory} The appropriate memory instance
   */
  const get_user_memory = () => {
    return user_memory || memory;
  };

  // ============================================================================
  // Syscall Pointer Map - Defines which arguments are pointers for translation
  // ============================================================================
  //
  // Format: syscall_nr -> { in: [arg_indices], out: [arg_indices], sizes: {arg_idx: size_arg_idx} }
  //   in: input pointers (data copied from user to kernel before syscall)
  //   out: output pointers (data copied from kernel to user after syscall)
  //   sizes: map of pointer arg index to size arg index
  //   string: true if pointer is a null-terminated string
  //
  // Common syscall numbers for RISC-V (used by Wasm):
  const SYS_read = 63;
  const SYS_write = 64;
  const SYS_openat = 56;
  const SYS_close = 57;
  const SYS_fstat = 80;
  const SYS_newfstatat = 79;
  const SYS_lseek = 62;
  const SYS_mmap = 222;
  const SYS_munmap = 215;
  const SYS_mprotect = 226;
  const SYS_brk = 214;
  const SYS_ioctl = 29;
  const SYS_readv = 65;
  const SYS_writev = 66;
  const SYS_pread64 = 67;
  const SYS_pwrite64 = 68;
  const SYS_readlinkat = 78;
  const SYS_mkdirat = 34;
  const SYS_unlinkat = 35;
  const SYS_renameat = 38;
  const SYS_getcwd = 17;
  const SYS_chdir = 49;
  const SYS_faccessat = 48;
  const SYS_futex = 98;
  const SYS_set_tid_address = 96;
  const SYS_exit = 93;
  const SYS_exit_group = 94;
  const SYS_clock_gettime = 113;
  const SYS_nanosleep = 101;
  const SYS_getpid = 172;
  const SYS_getuid = 174;
  const SYS_geteuid = 175;
  const SYS_getgid = 176;
  const SYS_getegid = 177;
  const SYS_gettid = 178;
  const SYS_clone = 220;
  const SYS_execve = 221;
  const SYS_wait4 = 260;
  const SYS_uname = 160;
  const SYS_getdents64 = 61;
  const SYS_ftruncate = 46;
  const SYS_statx = 291;

  const SYSCALL_POINTER_MAP = {
    // read(fd, buf, count) -> buf is output
    [SYS_read]: { out: [1], sizes: { 1: 2 } },

    // write(fd, buf, count) -> buf is input
    [SYS_write]: { in: [1], sizes: { 1: 2 } },

    // openat(dirfd, pathname, flags, mode) -> pathname is string input
    [SYS_openat]: { in: [1], string: { 1: true } },

    // fstat(fd, statbuf) -> statbuf is output
    [SYS_fstat]: { out: [1], sizes: { 1: 128 } },  // sizeof(struct stat)

    // newfstatat(dirfd, pathname, statbuf, flags) -> pathname input, statbuf output
    [SYS_newfstatat]: { in: [1], out: [2], string: { 1: true }, sizes: { 2: 128 } },

    // readlinkat(dirfd, pathname, buf, bufsiz) -> pathname input, buf output
    [SYS_readlinkat]: { in: [1], out: [2], string: { 1: true }, sizes: { 2: 3 } },

    // mkdirat(dirfd, pathname, mode) -> pathname is string input
    [SYS_mkdirat]: { in: [1], string: { 1: true } },

    // unlinkat(dirfd, pathname, flags) -> pathname is string input
    [SYS_unlinkat]: { in: [1], string: { 1: true } },

    // renameat(olddirfd, oldpath, newdirfd, newpath)
    [SYS_renameat]: { in: [1, 3], string: { 1: true, 3: true } },

    // getcwd(buf, size) -> buf is output
    [SYS_getcwd]: { out: [0], sizes: { 0: 1 } },

    // chdir(path) -> path is string input
    [SYS_chdir]: { in: [0], string: { 0: true } },

    // faccessat(dirfd, pathname, mode, flags) -> pathname is string input
    [SYS_faccessat]: { in: [1], string: { 1: true } },

    // futex(uaddr, op, val, timeout, uaddr2, val3) -> uaddr input/output
    [SYS_futex]: { inout: [0], sizes: { 0: 4 } },

    // set_tid_address(tidptr) -> tidptr is output
    [SYS_set_tid_address]: { out: [0], sizes: { 0: 4 } },

    // clock_gettime(clk_id, tp) -> tp is output
    [SYS_clock_gettime]: { out: [1], sizes: { 1: 16 } },  // sizeof(struct timespec)

    // nanosleep(req, rem) -> req input, rem output (optional)
    [SYS_nanosleep]: { in: [0], out: [1], sizes: { 0: 16, 1: 16 } },

    // uname(buf) -> buf is output
    [SYS_uname]: { out: [0], sizes: { 0: 390 } },  // sizeof(struct utsname)

    // getdents64(fd, dirp, count) -> dirp is output
    [SYS_getdents64]: { out: [1], sizes: { 1: 2 } },

    // statx(dirfd, pathname, flags, mask, statxbuf) -> pathname input, statxbuf output
    [SYS_statx]: { in: [1], out: [4], string: { 1: true }, sizes: { 4: 256 } },

    // execve(pathname, argv, envp) -> all pointers
    // Note: execve is special - it replaces the process image, handled separately
    [SYS_execve]: { in: [0, 1, 2], string: { 0: true } },

    // pread64(fd, buf, count, offset) -> buf is output
    [SYS_pread64]: { out: [1], sizes: { 1: 2 } },

    // pwrite64(fd, buf, count, offset) -> buf is input
    [SYS_pwrite64]: { in: [1], sizes: { 1: 2 } },

    // wait4(pid, wstatus, options, rusage) -> wstatus and rusage are outputs
    [SYS_wait4]: { out: [1, 3], sizes: { 1: 4, 3: 144 } },

    // readv(fd, iov, iovcnt) -> iovec array with output buffers
    [SYS_readv]: { iovec: { arg: 1, count_arg: 2, direction: 'out' } },

    // writev(fd, iov, iovcnt) -> iovec array with input buffers
    [SYS_writev]: { iovec: { arg: 1, count_arg: 2, direction: 'in' } },
  };

  // Size of iovec structure (ptr + size_t = 8 bytes on wasm32)
  const IOVEC_SIZE = 8;

  /**
   * Check if a syscall needs pointer translation
   * @param {number} nr - Syscall number
   * @returns {boolean} True if syscall has pointer arguments
   */
  const syscall_has_pointers = (nr) => {
    return SYSCALL_POINTER_MAP.hasOwnProperty(nr);
  };

  const lock_notify = (lock, count) => {
    Atomics.store(locks._memory, locks[lock], 1);
    Atomics.notify(locks._memory, locks[lock], count || 1);
  };

  const lock_wait = (lock) => {
    Atomics.wait(locks._memory, locks[lock], 0);
    Atomics.store(locks._memory, locks[lock], 0);
  };

  const serialize_me = () => {
    // Wait for some other task or CPU to wake us up.
    lock_wait("serialize");
    return switch_to_last_task[0];  // last_task was written by the caller just prior to waking.
  };

  /// Callbacks from within Linux/Wasm out to our host code (cpu is not neccessarily ours).
  const host_callbacks = {
    /// Start secondary CPU.
    wasm_start_cpu: (cpu, idle_task, start_stack) => {
      // New web workers cannot be spawned from within a Worker in most browsers. It can currently not be spawned from
      // within a SharedWorker in any browser. Do it on the main thread instead.
      port.postMessage({ method: "start_secondary", cpu: cpu, idle_task: idle_task, start_stack: start_stack });
    },

    /// Stop secondary CPU (rather abruptly).
    wasm_stop_cpu: (cpu) => {
      port.postMessage({ method: "stop_secondary", cpu: cpu });
    },

    /// Creation of tasks on our end. Runs them too.
    wasm_create_and_run_task: (prev_task, new_task, name, bin_start, bin_end, data_start, table_start) => {
      // Tell main to create the new task, and then run it for the first time!
      port.postMessage({
        method: "create_and_run_task",
        prev_task: prev_task,
        new_task: new_task,
        name: get_cstring(memory, name),

        // For user tasks, there is user code to load first before trying to run it.
        user_executable: bin_start ? {
          bin_start: bin_start,
          bin_end: bin_end,
          data_start: data_start,
          table_start: table_start,
        } : null,
      });

      // Serialize this (old) task.
      return serialize_me();
    },

    /// Remove a task created by wasm_create_and_run_task().
    wasm_release_task: (dead_task) => {
      port.postMessage({
        method: "release_task",
        dead_task: dead_task,
      });
    },

    /// Serialization of tasks (idle tasks and before SMP is started).
    wasm_serialize_tasks: (prev_task, next_task) => {
      // Notify the next task that it can run again.
      port.postMessage({
        method: "serialize_tasks",
        prev_task: prev_task,
        next_task: next_task,
      });

      // Serialize this (old) task.
      return serialize_me();
    },

    /// Kernel panic. We can't proceed.
    wasm_panic: (msg) => {
      const message = "Kernel panic: " + get_cstring(memory, msg);
      console.error(message);
      log(message);

      // This will stop execution of the current task.
      throw new Trap("panic");
    },

    /// Dump a stack trace into a text buffer. (The exact format is implementation-defined and varies by browser.)
    wasm_dump_stacktrace: (stack_trace, max_size) => {
      try {
        throw new Error();
      } catch (error) {
        const memory_u8 = new Uint8Array(memory.buffer);
        const encoded = text_encoder.encode(error.stack).slice(0, max_size - 1);
        memory_u8.set(encoded, stack_trace);
        memory_u8[stack_trace + encoded.length] = 0;
      }
    },

    /// Replace the currently executing image (kthread spawning init, or user process) with a new user process image.
    wasm_load_executable: (bin_start, bin_end, data_start, table_start) => {
      user_executable = WebAssembly.compile(new Uint8Array(memory.buffer).slice(bin_start, bin_end));
      user_executable_params = {
        data_start: data_start,
        table_start: table_start,
      };

      // We release our reference already, just to be sure. The promise chain will still have a reference until the
      // kernel exits back to userland, which will termintate the user executable with a Trap.
      user_executable_instance = null;
      user_executable_imports = null;
    },

    /// Handle user mode return (e.g. from syscall) that should not proceed normally. (Not called on normal returns.)
    wasm_user_mode_tail: (flow) => {
      if (flow == -1) {
        // Exec has been called and we should not return from the syscall. Trap() to collapse the call stack of the user
        // executable. When swallowed, run the new user executable that was already preloaded by wasm_load_executable().
        // This takes precedence of signal handlers or signal return - no reason to run any old user code!
        throw new Trap("reload_program");
      } else if (flow >= 1 && flow <= 3) {
        // First, handle any signal (possibly stacked). Then, handle any signal return (happens after stacked signals).
        // If exec() happens, we will slip out in the catch-else clause, ensuring the sigreturn does not proceed.
        if (flow & 1) {
          try {
            if (user_executable_instance.exports.__libc_handle_signal) {
              // Setup signal frame...
              user_executable_imports.env.__stack_pointer.value = vmlinux_instance.exports.get_user_stack_pointer();
              user_executable_instance.exports.__set_tls_base(vmlinux_instance.exports.get_user_tls_base());

              user_executable_instance.exports.__libc_handle_signal();
              throw new Error("Wasm function __libc_handle_signal() returned (it should never return)!");
            } else {
              throw new Error("Wasm function __libc_handle_signal() not defined!");
            }
          } catch (error) {
            if (error instanceof Trap && error.kind == "signal_return") {
              // ...restore signal frame.
              user_executable_imports.env.__stack_pointer.value = vmlinux_instance.exports.get_user_stack_pointer();
              user_executable_instance.exports.__set_tls_base(vmlinux_instance.exports.get_user_tls_base());
            } else {
              // Either a genuine error, or a Trap() from exec() (signal handlers are allowed to call exec()).
              throw error;
            }
          }
        }

        if (flow & 2) {
          throw new Trap("signal_return");
        }
      } else {
        throw new Error("wasm_syscall_tail called with unknown kind");
      }
    },

    // After this line follows host callbacks used by various drivers. In the future, we may make drivers more
    // modularized and allow them to allocate certain resources, like host callbacks, IRQ numbers, even syscalls...

    // Host callbacks by the Wasm-default clocksource.

    wasm_cpu_clock_get_monotonic: () => {
      // Convert this double in ms to u64 in us.
      // Modern browsers can on good days reach 5us accuracy, given that the platform supports it.
      return BigInt(Math.round(1000 * (performance.timeOrigin + performance.now()))) * 1000n;
    },

    // Host callbacks used by the Wasm-default console driver.

    wasm_driver_hvc_put: (buffer, count) => {
      const memory_u8 = new Uint8Array(memory.buffer);

      port.postMessage({
        method: "console_write",
        message: text_decoder.decode(memory_u8.slice(buffer, buffer + count)),
      });

      return count;
    },

    wasm_driver_hvc_get: (buffer, count) => {
      // Reset lock. Using .store() for the memory barrier.
      Atomics.store(console_read_messenger, 0, -1);

      // Tell the main thread to write any input into memory, up to count bytes.
      port.postMessage({
        method: "console_read",
        buffer: buffer,
        count: count,
        console_read_messenger: console_read_messenger,
      });

      // Wait for a response from the main thread about how many bytes were actually written, could be 0.
      Atomics.wait(console_read_messenger, 0, -1);
      let console_read_count = Atomics.load(console_read_messenger, 0);
      return console_read_count;
    },

    // Host callbacks for networking via WebSocket proxy

    wasm_net_open: (host_ptr, port_num) => {
      // Read host string from memory
      const host = get_cstring(memory, host_ptr);

      // Reset messenger: [status, result]
      Atomics.store(net_messenger, 0, -1);
      Atomics.store(net_messenger, 1, 0);

      // Request connection from main thread
      port.postMessage({
        method: "net_open",
        host: host,
        port: port_num,
        net_messenger: net_messenger,
      });

      // Wait for response
      Atomics.wait(net_messenger, 0, -1);

      const status = Atomics.load(net_messenger, 0);
      const result = Atomics.load(net_messenger, 1);

      // status 0 = success, result = connId
      // status 1 = error, result = error code
      if (status === 0) {
        return result;  // Return connection ID
      } else {
        return -1;  // Error
      }
    },

    wasm_net_write: (connId, buffer, len) => {
      // Reset messenger
      Atomics.store(net_messenger, 0, -1);

      // Request write from main thread
      port.postMessage({
        method: "net_write",
        connId: connId,
        buffer: buffer,
        len: len,
        net_messenger: net_messenger,
      });

      // Wait for response
      Atomics.wait(net_messenger, 0, -1);

      const status = Atomics.load(net_messenger, 0);
      // status 0 = success, status 1 = error
      return status === 0 ? len : -1;
    },

    wasm_net_read: (connId, buffer, count) => {
      // Reset messenger
      Atomics.store(net_messenger, 0, -1);
      Atomics.store(net_messenger, 1, 0);

      // Request read from main thread
      port.postMessage({
        method: "net_read",
        connId: connId,
        buffer: buffer,
        count: count,
        net_messenger: net_messenger,
      });

      // Wait for response
      Atomics.wait(net_messenger, 0, -1);

      const status = Atomics.load(net_messenger, 0);
      const bytesRead = Atomics.load(net_messenger, 1);

      // status 0 = success (bytesRead may be 0 if no data available)
      // status 1 = error
      // status 3 = connection closed
      if (status === 0) {
        return bytesRead;
      } else if (status === 3) {
        return 0;  // EOF - connection closed
      } else {
        return -1;  // Error
      }
    },

    wasm_net_poll: (connId) => {
      // Reset messenger
      Atomics.store(net_messenger, 0, -1);

      // Request poll from main thread
      port.postMessage({
        method: "net_poll",
        connId: connId,
        net_messenger: net_messenger,
      });

      // Wait for response
      Atomics.wait(net_messenger, 0, -1);

      // Return poll status:
      // 0 = no data available
      // 1 = data available
      // 2 = connection closed
      // 3 = error
      return Atomics.load(net_messenger, 0);
    },

    wasm_net_close: (connId) => {
      // Reset messenger
      Atomics.store(net_messenger, 0, -1);

      // Request close from main thread
      port.postMessage({
        method: "net_close",
        connId: connId,
        net_messenger: net_messenger,
      });

      // Wait for response
      Atomics.wait(net_messenger, 0, -1);

      return 0;  // Always succeed
    },

    // Host callbacks for filesystem persistence via IndexedDB

    wasm_fs_save: (path_ptr, buffer, len, mode) => {
      // Read path string from memory
      const path = get_cstring(memory, path_ptr);

      // Reset messenger
      Atomics.store(fs_messenger, 0, -1);

      // Request save from main thread
      port.postMessage({
        method: "fs_save",
        path: path,
        buffer: buffer,
        len: len,
        mode: mode,
        fs_messenger: fs_messenger,
      });

      // Wait for response
      Atomics.wait(fs_messenger, 0, -1);

      // Return 0 on success, -1 on error
      return Atomics.load(fs_messenger, 0) === 0 ? 0 : -1;
    },

    wasm_fs_load: (path_ptr, buffer, count) => {
      // Read path string from memory
      const path = get_cstring(memory, path_ptr);

      // Reset messenger
      Atomics.store(fs_messenger, 0, -1);
      Atomics.store(fs_messenger, 1, 0);

      // Request load from main thread
      port.postMessage({
        method: "fs_load",
        path: path,
        buffer: buffer,
        count: count,
        fs_messenger: fs_messenger,
      });

      // Wait for response
      Atomics.wait(fs_messenger, 0, -1);

      const status = Atomics.load(fs_messenger, 0);
      const bytesRead = Atomics.load(fs_messenger, 1);

      // Return bytes read on success, -1 on error, -2 on not found
      if (status === 0) {
        return bytesRead;
      } else if (status === 2) {
        return -2;  // File not found
      } else {
        return -1;  // Error
      }
    },

    wasm_fs_delete: (path_ptr) => {
      // Read path string from memory
      const path = get_cstring(memory, path_ptr);

      // Reset messenger
      Atomics.store(fs_messenger, 0, -1);

      // Request delete from main thread
      port.postMessage({
        method: "fs_delete",
        path: path,
        fs_messenger: fs_messenger,
      });

      // Wait for response
      Atomics.wait(fs_messenger, 0, -1);

      return Atomics.load(fs_messenger, 0) === 0 ? 0 : -1;
    },

    wasm_fs_list: (prefix_ptr, buffer, count) => {
      // Read prefix string from memory
      const prefix = get_cstring(memory, prefix_ptr);

      // Reset messenger
      Atomics.store(fs_messenger, 0, -1);
      Atomics.store(fs_messenger, 1, 0);

      // Request list from main thread
      port.postMessage({
        method: "fs_list",
        prefix: prefix,
        buffer: buffer,
        count: count,
        fs_messenger: fs_messenger,
      });

      // Wait for response
      Atomics.wait(fs_messenger, 0, -1);

      const status = Atomics.load(fs_messenger, 0);
      const bytesWritten = Atomics.load(fs_messenger, 1);

      return status === 0 ? bytesWritten : -1;
    },
  };

  /// Callbacks from the main thread.
  const message_callbacks = {
    init: (message) => {
      runner_name = message.runner_name;
      memory = message.memory;  // Kernel memory (shared)
      locks = message.locks;
      switch_to_last_task = message.last_task; // Only defined for tasks and CPU 0 (init task).

      // Memory isolation support
      if (message.user_memory) {
        user_memory = message.user_memory;
        syscall_buffer_offset = message.syscall_buffer_offset;
        syscall_buffer_size = message.syscall_buffer_size;
        log(`[MemIso] Initialized with isolated user memory, syscall buffer at 0x${syscall_buffer_offset.toString(16)}`);
      }

      if (message.user_executable) {
        // We are in a new runner that should duplicate the user executable. Happens when someone calls clone().
        host_callbacks.wasm_load_executable(
          message.user_executable.bin_start,
          message.user_executable.bin_end,
          message.user_executable.data_start,
          message.user_executable.table_start);
      }

      let import_object = {
        env: {
          ...host_callbacks,
          memory: message.memory,
        },
      };

      // We have to fixup unimplemented syscalls as they are declared but not defined by vmlinux (to avoid the
      // ni_syscall soup with unimplemented syscalls, which fails on Wasm due to a variable amount of arguments). Since
      // these syscalls should not really be called anyway, we can have a slow js stub deal with them, and it can handle
      // variable arguments gracefully!
      const ni_syscall = () => { return -38 /* aka. -ENOSYS */; };
      for (const imported of WebAssembly.Module.imports(message.vmlinux)) {
        if (imported.name.startsWith("sys_") && imported.module == "env"
          && imported.kind == "function") {
          import_object.env[imported.name] = ni_syscall;
        }
      }

      // This is a global error handler that is used when calling Wasm code.
      const wasm_error = (error) => {
        log("Wasm crash: " + error.toString());
        console.error(error);

        if (vmlinux_instance) {
          vmlinux_instance.exports.raise_exception();
          throw new Error("raise_exception() returned");
        } else {
          // Only log stack if vmlinux is not up already - it will dump stacks itself.
          log(error.stack);
          throw error;
        }
      };

      const vmlinux_setup = () => {
        // Instantiate a vmlinux Wasm Module. This will implicitly run __wasm_init_memory, which will effectively:
        // * Copy all passive data segments into their (static) position.
        // * Clear BSS (in its static position).
        // * Drop all passive data segments.
        // An in-memory atomic flag ensures this only happens the first time vmlinux is instantiated on the main memory.
        return WebAssembly.instantiate(message.vmlinux, import_object).then((instance) => {
          vmlinux_instance = instance;
        });
      };

      const vmlinux_run = () => {
        if (message.runner_type == "primary_cpu") {
          // Notify the main thread about init task so that it knows where it resides in memory.
          port.postMessage({
            method: "start_primary",
            init_task: vmlinux_instance.exports.init_task.value,
          });

          // Setup the boot command line. We have the luxury to be able to write to it directly. The maximum length is
          // not set here but is set by COMMAND_LINE_SIZE (defaults to 512 bytes).
          const cmdline = message.boot_cmdline + "\0";
          const cmdline_buffer = vmlinux_instance.exports.boot_command_line.value;
          new Uint8Array(memory.buffer).set(text_encoder.encode(cmdline), cmdline_buffer);

          // Grow the memory to fit initrd and copy it.
          //
          // All typed arrays and views on memory.buffer become invalid by growing and need to be re-created. grow()
          // will return the old size, which becomes our base address for initrd.
          const initrd_start = memory.grow(((message.initrd.byteLength + 0xFFFF) / 0x10000) | 0) * 0x10000;
          const initrd_end = initrd_start + message.initrd.byteLength;
          new Uint8Array(memory.buffer).set(new Uint8Array(message.initrd), initrd_start);
          new DataView(memory.buffer).setUint32(vmlinux_instance.exports.initrd_start.value, initrd_start, true);
          new DataView(memory.buffer).setUint32(vmlinux_instance.exports.initrd_end.value, initrd_end, true);

          // This will boot the maching on the primary CPU. Later on, it will boot secondaries...
          //
          // _start sets up the Wasm global __stack_pointer to init_stack and calls start_kernel(). Note that this will
          // grow the memory and thus all views on memory.buffer become invalid.
          vmlinux_instance.exports._start();

          // _start() will never return, unless it fails to allocate all memoy it wants to.
          throw new Error("_start did not even succeed in allocating 16 pages of RAM, aborting...");
        } else if (message.runner_type == "secondary_cpu") {
          // start_secondary() will never return. It can be killed by terminate() on this Worker.
          vmlinux_instance.exports._start_secondary(message.start_stack);

          throw new Error("start_secondary returned");
        } else if (message.runner_type == "task") {
          // A fresh task, possibly serialized on CPU 0 before secondaries are brought up.
          should_call_clone_callback = vmlinux_instance.exports.ret_from_fork(message.prev_task, message.new_task);

          // Two cases exist when we reach here:
          // 1. The kthread that spawned init retuned.
          // The code will already have been loaded, just execute it.
          //
          // 2. Someone called clone.
          // We should call the clone callback on the user executable, which has already been loaded.
          //
          // Notably, we don't end up here after exec() syscalls. Instead, the user instance is reloaded directly.
          return;
        } else {
          throw new Error("Unknown runner_type: " + message.runner_type);
        }
      };

      const user_executable_setup = () => {
        const stack_pointer = vmlinux_instance.exports.get_user_stack_pointer();
        const tls_base = vmlinux_instance.exports.get_user_tls_base();

        // Select appropriate memory: isolated user memory if available, otherwise shared kernel memory
        const exec_memory = user_memory || memory;

        // Track current offset within syscall buffer for multi-pointer syscalls
        let syscall_buffer_current = 0;

        // Reset buffer offset at start of each syscall
        const reset_syscall_buffer = () => {
          syscall_buffer_current = 0;
        };

        // Allocate space in syscall buffer, returns kernel pointer
        const alloc_syscall_buffer = (size) => {
          // Align to 8 bytes
          syscall_buffer_current = (syscall_buffer_current + 7) & ~7;
          const offset = syscall_buffer_current;
          syscall_buffer_current += size;

          if (syscall_buffer_current > syscall_buffer_size) {
            throw new Error("Syscall buffer overflow: needed " + syscall_buffer_current + " bytes");
          }

          return syscall_buffer_offset + offset;
        };

        // Copy data from user memory to kernel syscall buffer
        const copy_in = (user_ptr, size) => {
          if (user_ptr === 0) return 0;  // NULL pointer
          const kernel_ptr = alloc_syscall_buffer(size);
          const user_view = new Uint8Array(user_memory.buffer, user_ptr, size);
          const kernel_view = new Uint8Array(memory.buffer, kernel_ptr, size);
          kernel_view.set(user_view);
          return kernel_ptr;
        };

        // Copy null-terminated string from user to kernel
        const copy_string_in = (user_ptr) => {
          if (user_ptr === 0) return 0;
          const user_u8 = new Uint8Array(user_memory.buffer);
          let len = 0;
          while (user_u8[user_ptr + len] !== 0) len++;
          len++;  // Include null terminator
          return copy_in(user_ptr, len);
        };

        // Copy data from kernel back to user memory
        const copy_out = (user_ptr, kernel_ptr, size) => {
          if (user_ptr === 0 || kernel_ptr === 0) return;
          const kernel_view = new Uint8Array(memory.buffer, kernel_ptr, size);
          const user_view = new Uint8Array(user_memory.buffer, user_ptr, size);
          user_view.set(kernel_view);
        };

        // Handle iovec array translation for readv/writev
        // Returns: { kernel_iov: ptr, user_iovecs: [{base, len}...] }
        const translate_iovec_in = (user_iov_ptr, iovcnt, direction) => {
          if (user_iov_ptr === 0 || iovcnt === 0) return { kernel_iov: 0, user_iovecs: [] };

          const user_iovecs = [];
          const user_view = new DataView(user_memory.buffer);

          // Read user iovec array
          for (let i = 0; i < iovcnt; i++) {
            const base = user_view.getUint32(user_iov_ptr + i * IOVEC_SIZE, true);
            const len = user_view.getUint32(user_iov_ptr + i * IOVEC_SIZE + 4, true);
            user_iovecs.push({ base, len });
          }

          // Allocate kernel iovec array
          const kernel_iov = alloc_syscall_buffer(iovcnt * IOVEC_SIZE);
          const kernel_view = new DataView(memory.buffer);

          // For each iovec, translate the buffer pointer
          for (let i = 0; i < iovcnt; i++) {
            const { base, len } = user_iovecs[i];
            let kernel_base;

            if (direction === 'in') {
              // writev: copy data from user to kernel
              kernel_base = copy_in(base, len);
            } else {
              // readv: allocate kernel buffer (will copy back after syscall)
              kernel_base = alloc_syscall_buffer(len);
            }

            // Write translated iovec to kernel
            kernel_view.setUint32(kernel_iov + i * IOVEC_SIZE, kernel_base, true);
            kernel_view.setUint32(kernel_iov + i * IOVEC_SIZE + 4, len, true);

            // Store kernel_base for copy-back
            user_iovecs[i].kernel_base = kernel_base;
          }

          return { kernel_iov, user_iovecs };
        };

        // Copy iovec buffers back to user memory after readv
        const copy_iovec_out = (user_iovecs, bytes_read) => {
          let remaining = bytes_read;
          for (const iov of user_iovecs) {
            if (remaining <= 0) break;
            const to_copy = Math.min(iov.len, remaining);
            copy_out(iov.base, iov.kernel_base, to_copy);
            remaining -= to_copy;
          }
        };

        // Create syscall wrapper that translates pointers
        const make_syscall_wrapper = (kernel_syscall, arg_count) => {
          if (!user_memory) {
            // No isolation - use direct syscall
            return kernel_syscall;
          }

          // Return wrapper function based on argument count
          switch (arg_count) {
            case 0:
              return (nr) => kernel_syscall(nr);

            case 1:
              return (nr, a0) => {
                reset_syscall_buffer();
                const map = SYSCALL_POINTER_MAP[nr];
                let args = [a0];

                if (map) {
                  // Translate input pointers
                  if (map.in && map.in.includes(0)) {
                    if (map.string && map.string[0]) {
                      args[0] = copy_string_in(a0);
                    } else {
                      const size = map.sizes && map.sizes[0];
                      if (size) args[0] = copy_in(a0, typeof size === 'number' ? size : 256);
                    }
                  }
                }

                const result = kernel_syscall(nr, args[0]);

                if (map && map.out && map.out.includes(0)) {
                  const size = map.sizes && map.sizes[0];
                  if (size) copy_out(a0, args[0], typeof size === 'number' ? size : 256);
                }

                return result;
              };

            case 2:
              return (nr, a0, a1) => {
                reset_syscall_buffer();
                const map = SYSCALL_POINTER_MAP[nr];
                let args = [a0, a1];
                let original_args = [a0, a1];

                if (map) {
                  for (let i = 0; i < 2; i++) {
                    if (map.in && map.in.includes(i)) {
                      if (map.string && map.string[i]) {
                        args[i] = copy_string_in(original_args[i]);
                      } else {
                        let size = map.sizes && map.sizes[i];
                        if (typeof size === 'number') {
                          args[i] = copy_in(original_args[i], size);
                        } else if (size !== undefined) {
                          // Size is in another argument
                          args[i] = copy_in(original_args[i], original_args[size]);
                        }
                      }
                    }
                  }
                }

                const result = kernel_syscall(nr, args[0], args[1]);

                if (map && map.out) {
                  for (let i = 0; i < 2; i++) {
                    if (map.out.includes(i)) {
                      let size = map.sizes && map.sizes[i];
                      if (typeof size === 'number') {
                        copy_out(original_args[i], args[i], size);
                      } else if (size !== undefined) {
                        copy_out(original_args[i], args[i], original_args[size]);
                      }
                    }
                  }
                }

                return result;
              };

            case 3:
              return (nr, a0, a1, a2) => {
                reset_syscall_buffer();
                const map = SYSCALL_POINTER_MAP[nr];
                let args = [a0, a1, a2];
                let original_args = [a0, a1, a2];
                let iovec_info = null;

                if (map) {
                  // Handle iovec syscalls (readv/writev)
                  if (map.iovec) {
                    const iov_arg = map.iovec.arg;
                    const count_arg = map.iovec.count_arg;
                    iovec_info = translate_iovec_in(
                      original_args[iov_arg],
                      original_args[count_arg],
                      map.iovec.direction
                    );
                    args[iov_arg] = iovec_info.kernel_iov;
                  } else {
                    // Handle regular pointer arguments
                    for (let i = 0; i < 3; i++) {
                      if (map.in && map.in.includes(i)) {
                        if (map.string && map.string[i]) {
                          args[i] = copy_string_in(original_args[i]);
                        } else {
                          let size = map.sizes && map.sizes[i];
                          if (typeof size === 'number') {
                            args[i] = copy_in(original_args[i], size);
                          } else if (size !== undefined) {
                            args[i] = copy_in(original_args[i], original_args[size]);
                          }
                        }
                      }
                    }
                  }
                }

                const result = kernel_syscall(nr, args[0], args[1], args[2]);

                // Handle output
                if (map) {
                  // Handle iovec output (readv)
                  if (map.iovec && map.iovec.direction === 'out' && result > 0 && iovec_info) {
                    copy_iovec_out(iovec_info.user_iovecs, result);
                  } else if (map.out) {
                    // Handle regular output pointers
                    for (let i = 0; i < 3; i++) {
                      if (map.out.includes(i)) {
                        let size = map.sizes && map.sizes[i];
                        let actual_size;
                        if (typeof size === 'number') {
                          actual_size = size;
                        } else if (size !== undefined) {
                          actual_size = original_args[size];
                        }
                        // For read-like syscalls, only copy 'result' bytes on success
                        if (nr === SYS_read || nr === SYS_pread64 || nr === SYS_getdents64) {
                          if (result > 0) {
                            copy_out(original_args[i], args[i], result);
                          }
                        } else if (actual_size) {
                          copy_out(original_args[i], args[i], actual_size);
                        }
                      }
                    }
                  }
                }

                return result;
              };

            case 4:
              return (nr, a0, a1, a2, a3) => {
                reset_syscall_buffer();
                const map = SYSCALL_POINTER_MAP[nr];
                let args = [a0, a1, a2, a3];
                let original_args = [a0, a1, a2, a3];

                if (map) {
                  for (let i = 0; i < 4; i++) {
                    if (map.in && map.in.includes(i)) {
                      if (map.string && map.string[i]) {
                        args[i] = copy_string_in(original_args[i]);
                      } else {
                        let size = map.sizes && map.sizes[i];
                        if (typeof size === 'number') {
                          args[i] = copy_in(original_args[i], size);
                        } else if (size !== undefined) {
                          args[i] = copy_in(original_args[i], original_args[size]);
                        }
                      }
                    }
                  }
                }

                const result = kernel_syscall(nr, args[0], args[1], args[2], args[3]);

                if (map && map.out) {
                  for (let i = 0; i < 4; i++) {
                    if (map.out.includes(i)) {
                      let size = map.sizes && map.sizes[i];
                      let actual_size;
                      if (typeof size === 'number') {
                        actual_size = size;
                      } else if (size !== undefined) {
                        actual_size = original_args[size];
                      }
                      if (nr === SYS_readlinkat && i === 2 && result > 0) {
                        copy_out(original_args[i], args[i], result);
                      } else if (actual_size) {
                        copy_out(original_args[i], args[i], actual_size);
                      }
                    }
                  }
                }

                return result;
              };

            case 5:
              return (nr, a0, a1, a2, a3, a4) => {
                reset_syscall_buffer();
                const map = SYSCALL_POINTER_MAP[nr];
                let args = [a0, a1, a2, a3, a4];
                let original_args = [a0, a1, a2, a3, a4];

                if (map) {
                  for (let i = 0; i < 5; i++) {
                    if (map.in && map.in.includes(i)) {
                      if (map.string && map.string[i]) {
                        args[i] = copy_string_in(original_args[i]);
                      } else {
                        let size = map.sizes && map.sizes[i];
                        if (typeof size === 'number') {
                          args[i] = copy_in(original_args[i], size);
                        } else if (size !== undefined) {
                          args[i] = copy_in(original_args[i], original_args[size]);
                        }
                      }
                    }
                  }
                }

                const result = kernel_syscall(nr, args[0], args[1], args[2], args[3], args[4]);

                if (map && map.out) {
                  for (let i = 0; i < 5; i++) {
                    if (map.out.includes(i)) {
                      let size = map.sizes && map.sizes[i];
                      if (typeof size === 'number') {
                        copy_out(original_args[i], args[i], size);
                      } else if (size !== undefined) {
                        copy_out(original_args[i], args[i], original_args[size]);
                      }
                    }
                  }
                }

                return result;
              };

            case 6:
              return (nr, a0, a1, a2, a3, a4, a5) => {
                reset_syscall_buffer();
                const map = SYSCALL_POINTER_MAP[nr];
                let args = [a0, a1, a2, a3, a4, a5];
                let original_args = [a0, a1, a2, a3, a4, a5];

                if (map) {
                  for (let i = 0; i < 6; i++) {
                    if (map.in && map.in.includes(i)) {
                      if (map.string && map.string[i]) {
                        args[i] = copy_string_in(original_args[i]);
                      } else {
                        let size = map.sizes && map.sizes[i];
                        if (typeof size === 'number') {
                          args[i] = copy_in(original_args[i], size);
                        } else if (size !== undefined) {
                          args[i] = copy_in(original_args[i], original_args[size]);
                        }
                      }
                    }
                  }
                }

                const result = kernel_syscall(nr, args[0], args[1], args[2], args[3], args[4], args[5]);

                if (map && map.out) {
                  for (let i = 0; i < 6; i++) {
                    if (map.out.includes(i)) {
                      let size = map.sizes && map.sizes[i];
                      if (typeof size === 'number') {
                        copy_out(original_args[i], args[i], size);
                      } else if (size !== undefined) {
                        copy_out(original_args[i], args[i], original_args[size]);
                      }
                    }
                  }
                }

                return result;
              };

            default:
              return kernel_syscall;
          }
        };

        user_executable_imports = {
          env: {
            // Use isolated memory for user executable when available
            memory: exec_memory,
            __memory_base: new WebAssembly.Global({ value: 'i32', mutable: false }, user_executable_params.data_start),
            __stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, stack_pointer),
            __indirect_function_table: new WebAssembly.Table({ initial: 4096, element: "anyfunc" }), // TODO: fix this!
            __table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, user_executable_params.table_start),

            // To be correct, we should save AND restore these globals between the user instance and vmlinux instance:
            // __stack_pointer <-> __user_stack_pointer
            // __tls_base <-> __user_tls_base
            // The kernel interacts with them in the following ways:
            // * Diagnostics (reading them and displaying them in informational messages).
            // * ret_from_fork: writes stack and tls. We have to deal with it, but not here, as this is not a syscall!
            // * syscall exec: tls should be kept even if the process image is replaced (probably has no real use case).
            // * syscall clone: stack and tls should be transfered to the new instance, unless overridden.
            // * signal handlers: also not a syscall - vmlinux calls the host, perhaps during syscall return!
            // The kernel never modifies neither of them for the task that makes a syscall.
            //
            // To make syscalls faster (allowing them to not go through a slow JavaScript wrapper), we skip transferring
            // them back to the user instance. They always have to be transferred to vmlinux at syscall sites, as a
            // signal being handled in its return path would need to save (and restore) them on its signal stack.
            //
            // NOTE: With memory isolation, syscalls with pointer arguments need translation.
            // Phase 2 will add proper pointer translation through the syscall buffer.
            __wasm_syscall_0: make_syscall_wrapper(vmlinux_instance.exports.wasm_syscall_0, 0),
            __wasm_syscall_1: make_syscall_wrapper(vmlinux_instance.exports.wasm_syscall_1, 1),
            __wasm_syscall_2: make_syscall_wrapper(vmlinux_instance.exports.wasm_syscall_2, 2),
            __wasm_syscall_3: make_syscall_wrapper(vmlinux_instance.exports.wasm_syscall_3, 3),
            __wasm_syscall_4: make_syscall_wrapper(vmlinux_instance.exports.wasm_syscall_4, 4),
            __wasm_syscall_5: make_syscall_wrapper(vmlinux_instance.exports.wasm_syscall_5, 5),
            __wasm_syscall_6: make_syscall_wrapper(vmlinux_instance.exports.wasm_syscall_6, 6),

            __wasm_abort: () => {
              debugger
              throw WebAssembly.RuntimeError('abort');
            },
          },
        };

        // Instantiate a user Wasm Module. This will implicitly run __wasm_init_memory, which will effectively:
        // * Initialize the TLS pointer (to a data_start-relocated static area, for the first thread).
        // * Copy all passive data segments into their (data_start-relocated) position.
        // * Clear BSS (data_start-relocated).
        // * Drop all passive data segments (except the TLS region, which is saved, but unused in the musl case).
        // An atomic flag ensures this only happens for the first thread to be started (using instantiate).
        //
        // The TLS pointer will be initialized in the following way ways:
        // * kthread-returns-to-init: __user_tls_base would be 0 as it's zero-initialized on the kthreads switch_stack.
        //   (We are ignoring it.) __wasm_init_memory() would initialize it to the static area as described above.
        //
        // * exec: __user_tls_base should have been the value of the process calling exec (during the syscall). However,
        //   we would want to restore it as part of initializing the runtime, which is exactly what __wasm_init_memory()
        //   does. This also means that whatever value the task calling exec() supplied for tls is ignored.
        //
        // * clone: clone explicitly passes its tls pointer to the kernel as part of the syscall. Unless the tls pointer
        //   has been overridden with CLONE_SETTLS, it will be copied from the old task to the new one. This is mostly
        //   useful when CLONE_VFORK is used, in which case the new task can borrow the TLS until it calls exec or exit.
        let woken = user_executable.then((user_module) => WebAssembly.instantiate(user_module, user_executable_imports));

        woken = woken.then((instance) => {
          instance.exports.__wasm_apply_data_relocs();
          if (should_call_clone_callback) {
            // Note: __wasm_init_tls cannot be used as it would also re-initilize the _Thread_local variables' data. But
            // on a clone(), it is none of our business to do that. It's up to the libc to do that as part of pthreads.
            // Indeed, for example on a clone with CLONE_VFORK, the right thing to do may be to borrow the parent's TLS.
            // Unfortunately, LLVM does not export __tls_base directly on dynamic libraries, so we go through a wrapper.
            instance.exports.__set_tls_base(tls_base);
          }
          user_executable_instance = instance;
          return instance;
        });

        return woken;
      };

      const user_executable_run = (instance) => {
        if (should_call_clone_callback) {
          // We have to reset this state, because if the clone callback calls exec, we have to run _start() instead!
          should_call_clone_callback = false;

          if (instance.exports.__libc_clone_callback) {
            instance.exports.__libc_clone_callback();
            throw new Error("Wasm function __libc_clone_callback() returned (it should never return)!");
          } else {
            throw new Error("Wasm function __libc_clone_callback() not defined!");
          }
        } else {
          if (instance.exports._start) {
            // Ideally libc would do this instead of the usual __init_array stuff (e.g. override __libc_start_init in
            // musl). However, a reference to __wasm_call_ctors becomes a GOT import in -fPIC code, perhaps rightfully
            // so with the current implementation and use case on LLVM. Anyway, we do it here, slightly early on...
            if (instance.exports.__wasm_call_ctors) {
              instance.exports.__wasm_call_ctors();
            }

            // TLS: somewhat incorrectly contains 0 instead of the TP before exec(). Since we will anyway not care about
            // its value (__wasm_apply_data_relocs() called would have overwritten it in this case) it does not matter.
            instance.exports._start();
            throw new Error("Wasm function _start() returned (it should never return)!");
          } else {
            throw new Error("Wasm function _start() not defined!");
          }
        }
      };

      const user_executable_error = (error) => {
        if (error instanceof Trap) {
          if (error.kind == "reload_program") {
            // Someone called exec and the currently executing code should stop. We should run the new user code already
            // loaded by wasm_load_executable().
            return user_executable_chain();
          } else if (error.kind == "panic") {
            // This has already been handled - just swallow it. This Worker will be done - but kept for later debugging.
          } else {
            throw new Error("Unexpected Wasm host Trap " + error.kind);
          }
        } else {
          wasm_error(error);
        }
      };

      const user_executable_chain = () => {
        // user_executable_error() may deal with an exec() trap and recursively call run_chain() again.
        return user_executable_setup().then(user_executable_run).catch(user_executable_error);
      };

      // All tasks start in the kernel, some return to userland, where they should never return. If they return, we
      // handle this as an error and wait. Our life ends when the kernel kills us by terminating the whole Worker. Oh,
      // and exex() can trap us, in which case we have to circle back to loading new user code and executing it agian.
      vmlinux_setup().then(vmlinux_run).catch(wasm_error).then(user_executable_chain);
    },
  };

  self.onmessage = (message_event) => {
    const data = message_event.data;
    message_callbacks[data.method](data);
  };

  self.onmessageerror = (error) => {
    throw error;
  };
})(console);
