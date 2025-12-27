// SPDX-License-Identifier: GPL-2.0-only

/// Create a Linux machine and run it.
const linux = async (worker_url, vmlinux, boot_cmdline, initrd, log, console_write) => {
  /// Dict of online CPUs.
  const cpus = {};

  /// Dict of tasks.
  const tasks = {};

  /// Input buffer (from keyboard to tty).
  let input_buffer = new ArrayBuffer(0);

  const text_decoder = new TextDecoder("utf-8");
  const text_encoder = new TextEncoder();

  // Networking support
  let netProxy = null;
  const netConnections = new Map();  // connId -> { buffer, closed, error }

  // Filesystem persistence support
  let fsPersist = null;

  const lock_notify = (locks, lock, count) => {
    Atomics.store(locks._memory, locks[lock], 1);
    Atomics.notify(locks._memory, locks[lock], count || 1);
  };

  const lock_wait = (locks, lock) => {
    Atomics.wait(locks._memory, locks[lock], 0);
    Atomics.store(locks._memory, locks[lock], 0);
  };

  /// Callbacks from Web Workers (each one representing one task).
  const message_callbacks = {
    start_primary: (message) => {
      // CPU 0 has init_task which sits in static storage. After booting it becomes CPU 0's idle task. The runner will
      // in this special case tell us where it is so that we can register it.
      log("Starting cpu 0 with init_task " + message.init_task)
      tasks[message.init_task] = cpus[0];
    },

    start_secondary: (message) => {
      if (message.cpu <= 0) {
        throw new Error("Trying to start secondary cpu with ID <= 0");
      }

      log("Starting cpu " + message.cpu + " (" + message.idle_task + ")" +
        " with start stack " + message.start_stack);
      make_cpu(message.cpu, message.idle_task, message.start_stack);
    },

    stop_secondary: (message) => {
      if (message.cpu <= 0) {
        // If you arrive here, you probably got panic():ed with a broken stack.
        if (!confirm("Trying to stop secondary cpu with ID 0.\n\n" +
          "You probably got panic():ed with a broken stack. Continue?\n\n" +
          " (Say ok if you know what you are doing and want to catch the panic, otherwise cancel.)")) {
          throw new Error("Trying to stop secondary cpu with ID 0");
        }
      }

      if (cpus[message.cpu]) {
        log("[Main]: Stopping CPU " + message.cpu);
        cpus[message.cpu].worker.terminate();
        delete cpus[message.cpu];
      } else {
        log("[Main]: Tried to stop CPU " + message.cpu + " but it was already stopped (broken system)!");
      }
    },

    create_and_run_task: (message) => {
      // ret_from_fork will make sure the task switch finishes.
      make_task(message.prev_task, message.new_task, message.name, message.user_executable);
    },

    release_task: (message) => {
      // Stop the worker, which will stop script execution. This is safe as the task should be hanging on a lock waiting
      // to be scheduled - which never happens as dead tasks don't get ever get scheduled.
      tasks[message.dead_task].worker.terminate();

      delete tasks[message.dead_task];
    },

    serialize_tasks: (message) => {
      // next_task was previously suspended, wake it up.

      // Tell the next task where we switched from, so that it can finish the task switch.
      tasks[message.next_task].last_task[0] = message.prev_task;

      // Release the above write of last_task and wake up the task.
      lock_notify(tasks[message.next_task].locks, "serialize");
    },

    console_read: (message, worker) => {
      const memory_u8 = new Uint8Array(memory.buffer);
      const buffer = new Uint8Array(input_buffer);

      const used = buffer.slice(0, message.count);
      memory_u8.set(used, message.buffer);

      const unused = buffer.slice(message.count);
      input_buffer = unused.buffer;

      // Tell the Worker that asked for input how many bytes (perhaps 0) were actually written.
      Atomics.store(message.console_read_messenger, 0, used.length);
      Atomics.notify(message.console_read_messenger, 0, 1);
    },

    console_write: (message) => {
      console_write(message.message);
    },

    log: (message) => {
      log(message.message);
    },

    // Networking callbacks
    net_open: async (message, worker) => {
      if (!netProxy) {
        Atomics.store(message.net_messenger, 0, 1);  // error status
        Atomics.store(message.net_messenger, 1, -1); // error code
        Atomics.notify(message.net_messenger, 0, 1);
        return;
      }

      try {
        const connId = await netProxy.open(message.host, message.port);

        netConnections.set(connId, {
          buffer: new Uint8Array(0),
          closed: false,
          error: null,
        });

        netProxy.onData(connId, (data) => {
          const conn = netConnections.get(connId);
          if (conn) {
            const newBuffer = new Uint8Array(conn.buffer.length + data.length);
            newBuffer.set(conn.buffer);
            newBuffer.set(data, conn.buffer.length);
            conn.buffer = newBuffer;
          }
        });

        netProxy.onClose(connId, () => {
          const conn = netConnections.get(connId);
          if (conn) conn.closed = true;
        });

        netProxy.onError(connId, (err) => {
          const conn = netConnections.get(connId);
          if (conn) conn.error = err.message;
        });

        Atomics.store(message.net_messenger, 0, 0);  // success
        Atomics.store(message.net_messenger, 1, connId);
        Atomics.notify(message.net_messenger, 0, 1);

      } catch (err) {
        log('[Net] Open failed: ' + err.message);
        Atomics.store(message.net_messenger, 0, 1);  // error
        Atomics.store(message.net_messenger, 1, -1);
        Atomics.notify(message.net_messenger, 0, 1);
      }
    },

    net_write: (message, worker) => {
      if (!netProxy) {
        Atomics.store(message.net_messenger, 0, 1);
        Atomics.notify(message.net_messenger, 0, 1);
        return;
      }

      try {
        const memory_u8 = new Uint8Array(memory.buffer);
        const data = memory_u8.slice(message.buffer, message.buffer + message.len);
        netProxy.write(message.connId, data);
        Atomics.store(message.net_messenger, 0, 0);
        Atomics.notify(message.net_messenger, 0, 1);
      } catch (err) {
        log('[Net] Write failed: ' + err.message);
        Atomics.store(message.net_messenger, 0, 1);
        Atomics.notify(message.net_messenger, 0, 1);
      }
    },

    net_read: (message, worker) => {
      const conn = netConnections.get(message.connId);

      if (!conn) {
        Atomics.store(message.net_messenger, 0, 1);
        Atomics.store(message.net_messenger, 1, 0);
        Atomics.notify(message.net_messenger, 0, 1);
        return;
      }

      if (conn.buffer.length > 0) {
        const memory_u8 = new Uint8Array(memory.buffer);
        const toRead = Math.min(conn.buffer.length, message.count);
        memory_u8.set(conn.buffer.slice(0, toRead), message.buffer);
        conn.buffer = conn.buffer.slice(toRead);

        Atomics.store(message.net_messenger, 0, 0);
        Atomics.store(message.net_messenger, 1, toRead);
        Atomics.notify(message.net_messenger, 0, 1);

      } else if (conn.closed) {
        Atomics.store(message.net_messenger, 0, 3);  // closed
        Atomics.store(message.net_messenger, 1, 0);
        Atomics.notify(message.net_messenger, 0, 1);

      } else if (conn.error) {
        Atomics.store(message.net_messenger, 0, 1);  // error
        Atomics.store(message.net_messenger, 1, 0);
        Atomics.notify(message.net_messenger, 0, 1);

      } else {
        Atomics.store(message.net_messenger, 0, 0);
        Atomics.store(message.net_messenger, 1, 0);
        Atomics.notify(message.net_messenger, 0, 1);
      }
    },

    net_poll: (message, worker) => {
      const conn = netConnections.get(message.connId);

      if (!conn) {
        Atomics.store(message.net_messenger, 0, 1);
        Atomics.notify(message.net_messenger, 0, 1);
        return;
      }

      if (conn.error) {
        Atomics.store(message.net_messenger, 0, 3);
      } else if (conn.closed && conn.buffer.length === 0) {
        Atomics.store(message.net_messenger, 0, 2);
      } else if (conn.buffer.length > 0) {
        Atomics.store(message.net_messenger, 0, 1);
      } else {
        Atomics.store(message.net_messenger, 0, 0);
      }
      Atomics.notify(message.net_messenger, 0, 1);
    },

    net_close: (message, worker) => {
      if (netProxy && netConnections.has(message.connId)) {
        netProxy.close(message.connId);
        netConnections.delete(message.connId);
      }
      Atomics.store(message.net_messenger, 0, 0);
      Atomics.notify(message.net_messenger, 0, 1);
    },

    // Filesystem persistence callbacks
    fs_save: async (message, worker) => {
      if (!fsPersist) {
        Atomics.store(message.fs_messenger, 0, 1);  // error - not initialized
        Atomics.notify(message.fs_messenger, 0, 1);
        return;
      }

      try {
        const memory_u8 = new Uint8Array(memory.buffer);
        const content = memory_u8.slice(message.buffer, message.buffer + message.len);
        await fsPersist.saveFile(message.path, content, { mode: message.mode || 0o644 });
        Atomics.store(message.fs_messenger, 0, 0);  // success
        Atomics.notify(message.fs_messenger, 0, 1);
      } catch (err) {
        log('[FS] Save failed: ' + err.message);
        Atomics.store(message.fs_messenger, 0, 1);  // error
        Atomics.notify(message.fs_messenger, 0, 1);
      }
    },

    fs_load: async (message, worker) => {
      if (!fsPersist) {
        Atomics.store(message.fs_messenger, 0, 1);
        Atomics.store(message.fs_messenger, 1, 0);
        Atomics.notify(message.fs_messenger, 0, 1);
        return;
      }

      try {
        const file = await fsPersist.loadFile(message.path);
        if (file) {
          const memory_u8 = new Uint8Array(memory.buffer);
          const toRead = Math.min(file.content.length, message.count);
          memory_u8.set(file.content.slice(0, toRead), message.buffer);
          Atomics.store(message.fs_messenger, 0, 0);  // success
          Atomics.store(message.fs_messenger, 1, toRead);  // bytes read
        } else {
          Atomics.store(message.fs_messenger, 0, 2);  // file not found
          Atomics.store(message.fs_messenger, 1, 0);
        }
        Atomics.notify(message.fs_messenger, 0, 1);
      } catch (err) {
        log('[FS] Load failed: ' + err.message);
        Atomics.store(message.fs_messenger, 0, 1);  // error
        Atomics.store(message.fs_messenger, 1, 0);
        Atomics.notify(message.fs_messenger, 0, 1);
      }
    },

    fs_delete: async (message, worker) => {
      if (!fsPersist) {
        Atomics.store(message.fs_messenger, 0, 1);
        Atomics.notify(message.fs_messenger, 0, 1);
        return;
      }

      try {
        await fsPersist.deleteFile(message.path);
        Atomics.store(message.fs_messenger, 0, 0);  // success
        Atomics.notify(message.fs_messenger, 0, 1);
      } catch (err) {
        log('[FS] Delete failed: ' + err.message);
        Atomics.store(message.fs_messenger, 0, 1);  // error
        Atomics.notify(message.fs_messenger, 0, 1);
      }
    },

    fs_list: async (message, worker) => {
      if (!fsPersist) {
        Atomics.store(message.fs_messenger, 0, 1);
        Atomics.store(message.fs_messenger, 1, 0);
        Atomics.notify(message.fs_messenger, 0, 1);
        return;
      }

      try {
        const files = await fsPersist.listFiles(message.prefix);
        // Write file list as newline-separated paths into the buffer
        const pathList = files.map(f => f.path).join('\n');
        const encoded = text_encoder.encode(pathList);
        const memory_u8 = new Uint8Array(memory.buffer);
        const toWrite = Math.min(encoded.length, message.count);
        memory_u8.set(encoded.slice(0, toWrite), message.buffer);
        Atomics.store(message.fs_messenger, 0, 0);  // success
        Atomics.store(message.fs_messenger, 1, toWrite);  // bytes written
        Atomics.notify(message.fs_messenger, 0, 1);
      } catch (err) {
        log('[FS] List failed: ' + err.message);
        Atomics.store(message.fs_messenger, 0, 1);
        Atomics.store(message.fs_messenger, 1, 0);
        Atomics.notify(message.fs_messenger, 0, 1);
      }
    },
  };

  /// Memory shared between all CPUs.
  const memory = new WebAssembly.Memory({
    initial: 30, // TODO: extract this automatically from vmlinux.
    maximum: 0x10000, // Allow the full 32-bit address space to be allocated.
    shared: true,
  });

  /**
   * Create and run one CPU in a background thread (a Web Worker).
   *
   * This will run boot code for the CPU, and then drop to run the idle task. For CPU 0 this involves booting the entire
   * system, including bringing up secondary CPUs at the end, while for secondary CPUs, this just means some
   * book-keeping before dropping into their own idle tasks.
   */
  const make_cpu = (cpu, idle_task, start_stack) => {
    const options = {
      runner_type: (cpu == 0) ? "primary_cpu" : "secondary_cpu",
      start_stack: start_stack,  // undefined for CPU 0
    };

    if (cpu == 0) {
      options.boot_cmdline = boot_cmdline;
      options.initrd = initrd;
      initrd = null;  // allow gc
    }

    // idle_task is undefined for cpu 0, we will know it first when start_primary notifies us.
    const name = "CPU " + cpu + " [boot+idle]" + (cpu != 0 ? " (" + idle_task + ")" : "");

    const runner = make_vmlinux_runner(name, options);
    cpus[cpu] = runner;
    if (cpu != 0) {
      tasks[idle_task] = runner; // For CPU 0, start_primary does this registration for us.
    }
  };

  /**
   * Create and run one task. This task has been switch_to():ed by the scheduler for the first time.
   *
   * In the beginning, all tasks are serialized and have to cooperate to schedule eachother, but after secondary CPUs
   * are brought up, they can run concurrently (and will effectively be managed by the Wasm host OS). While we are not
   * able to suspend them from JS, the host OS will do that.
   */
  const make_task = (prev_task, new_task, name, user_executable) => {
    const options = {
      runner_type: "task",
      prev_task: prev_task,
      new_task: new_task,
      user_executable: user_executable,
    };
    tasks[new_task] = make_vmlinux_runner(name + " (" + new_task + ")", options);
  };

  /// Create a runner for vmlinux. It will run in a Web Worker and execute some specified code.
  const make_vmlinux_runner = (name, options) => {
    // Note: SharedWorker does not seem to allow WebAssembly Module or Memory instances posted.
    const worker = new Worker(worker_url, { name: name });

    let locks = {
      serialize: 0,
    };
    locks._memory = new Int32Array(new SharedArrayBuffer(Object.keys(locks).length * 4));

    // Store for last task when wasm_serialize() returns in switch_to(). Needed for each task, both normal ones and each
    // CPUs idle tasks (first called init_task (PID 0), not to be confused with init (PID 1) which is a normal task).
    const last_task = new Uint32Array(new SharedArrayBuffer(4));

    worker.onerror = (error) => {
      throw error;
    };

    worker.onmessage = (message_event) => {
      const data = message_event.data;
      message_callbacks[data.method](data, worker);
    };

    worker.onmessageerror = (error) => {
      throw error;
    };

    worker.postMessage({
      ...options,
      method: "init",
      vmlinux: vmlinux,
      memory: memory,
      locks: locks,
      last_task: last_task,
      runner_name: name,
    });

    return {
      worker: worker,
      locks: locks,
      last_task: last_task,
    };
  };

  // Create the primary cpu, it will later on callback to us and we start secondaries.
  make_cpu(0);

  return {
    key_input: (data) => {
      const key_buffer = text_encoder.encode(data);  // Possibly UTF-8 (up to 16 bits).

      // Append key_buffer to the end of input_buffer.
      const old_size = input_buffer.byteLength;
      input_buffer = input_buffer.transfer(old_size + key_buffer.byteLength);
      (new Uint8Array(input_buffer)).set(key_buffer, old_size);
    },

    // Initialize networking proxy
    initNetProxy: (wsUrl, options = {}) => {
      if (typeof NetProxy === 'undefined') {
        log('[Net] NetProxy not loaded, networking disabled');
        return false;
      }
      netProxy = new NetProxy(wsUrl, options);
      log('[Net] Networking enabled via ' + wsUrl);
      return true;
    },

    // Initialize filesystem persistence
    initFsPersist: async () => {
      if (typeof FilesystemPersist === 'undefined') {
        log('[FS] FilesystemPersist not loaded, persistence disabled');
        return false;
      }
      try {
        fsPersist = new FilesystemPersist();
        await fsPersist.init();
        log('[FS] Filesystem persistence enabled');
        return true;
      } catch (err) {
        log('[FS] Failed to initialize persistence: ' + err.message);
        return false;
      }
    },

    // Get filesystem persistence instance for direct access
    getFsPersist: () => fsPersist
  };
};
