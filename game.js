var Module = typeof Module !== "undefined" ? Module : {};

var ENVIRONMENT_IS_WEB = !!globalThis.window;

var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;

var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

(() => {
    const BLOCK = 1 << 20;
    const F = Module.uewFiles = {
        base: Module.uewDataUrl || "data/",
        part: 16 << 20,
        cacheMax: (Module.uewCacheMB || 640) << 20,
        files: [],
        byPath: new Map,
        dirs: new Map,
        cache: new Map,
        cacheBytes: 0,
        pending: new Map,
        next: new Map,
        fetched: 0
    };
    async function readDataResponse(response) {
        if (!response.body) {
            const buffer = await response.arrayBuffer();
            F.received = (F.received || 0) + buffer.byteLength;
            return buffer;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const {done: done, value: value} = await reader.read();
                if (done) break;
                chunks.push(value);
                size += value.byteLength;
                F.received = (F.received || 0) + value.byteLength;
            }
        } finally {
            reader.releaseLock();
        }
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return result.buffer;
    }
    const norm = p => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
    const key = (id, b) => id * 1048576 + b;
    Module.uewWake = () => {
        const w = Module.uewIdleWake;
        if (w) {
            Module.uewIdleWake = null;
            w();
        }
    };
    F.load = text => {
        const lines = text.split(/\r?\n/);
        const head = lines[0].split(" ");
        if (head[0] != "uewasm-files") throw new Error("bad data/index.txt");
        F.part = +head[2];
        const addDir = (orig, name, e) => {
            const p = norm(orig);
            let d = F.dirs.get(p);
            if (!d) {
                d = new Map;
                F.dirs.set(p, d);
                const i = orig.lastIndexOf("/");
                if (i >= 0) addDir(orig.slice(0, i), orig.slice(i + 1), {
                    dir: true
                });
            }
            if (name && !d.has(name)) d.set(name, e);
        };
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i]) continue;
            const [size, mtime, flags, path, blocks] = lines[i].split("\t");
            const f = {
                id: F.files.length,
                size: +size,
                mtime: +mtime,
                stub: flags == "1",
                z: flags == "2",
                blocks: blocks
            };
            F.files.push(f);
            const n = norm(path);
            F.byPath.set(n, f);
            const j = path.lastIndexOf("/");
            addDir(path.slice(0, j), path.slice(j + 1), f);
        }
    };
    F.lookup = p => {
        p = norm(p);
        return F.byPath.get(p) || (F.dirs.has(p) ? {
            dir: true
        } : null);
    };
    F.list = p => {
        const d = F.dirs.get(norm(p));
        if (!d) return null;
        let s = "";
        for (const [name, e] of d) s += `${name}\t${e.dir ? 1 : 0}\t${e.size || 0}\t${e.mtime || 0}\n`;
        return s;
    };
    const get = k => {
        const v = F.cache.get(k);
        if (v) {
            F.cache.delete(k);
            F.cache.set(k, v);
        }
        return v;
    };
    const put = (k, buf) => {
        if (F.cache.has(k)) return;
        F.cache.set(k, buf);
        F.cacheBytes += buf.byteLength;
        while (F.cacheBytes > F.cacheMax) {
            const [k0, v0] = F.cache.entries().next().value;
            F.cache.delete(k0);
            F.cacheBytes -= v0.byteLength;
        }
    };
    const url = (id, part) => F.base + (part ? `${id}.${part}` : `${id}`);
    const layout = f => {
        if (f.L) return f.L;
        if (!f.z) {
            const per = F.part / BLOCK, n = Math.max(1, Math.ceil(f.size / BLOCK));
            f.L = Array.from({
                length: n
            }, (_, b) => ({
                part: Math.floor(b / per),
                off: b % per * BLOCK,
                len: Math.min(BLOCK, f.size - b * BLOCK)
            }));
        } else {
            let part = 0, used = 0;
            f.L = f.blocks.split(",").map(x => {
                const len = parseInt(x, 16);
                if (used && used + len > F.part) {
                    part++;
                    used = 0;
                }
                const e = {
                    part: part,
                    off: used,
                    len: len
                };
                used += len;
                return e;
            });
        }
        return f.L;
    };
    const inflate = async buf => new Uint8Array(await new Response(new Blob([ buf ]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    const unpack = (f, b, buf) => {
        const raw = Math.min(BLOCK, f.size - b * BLOCK);
        return f.z && buf.length != raw ? inflate(buf) : buf;
    };
    async function download(f, b) {
        if (f.stub) return new Uint8Array(Math.min(BLOCK, f.size - b * BLOCK));
        const L = layout(f), e = L[b];
        const whole = L.length == 1;
        for (let attempt = 0; ;attempt++) {
            try {
                const t0 = performance.now();
                F.inflight = (F.inflight || 0) + 1;
                F.maxInflight = Math.max(F.maxInflight || 0, F.inflight);
                const r = await fetch(url(f.id, e.part), whole ? {} : {
                    headers: {
                        Range: `bytes=${e.off}-${e.off + e.len - 1}`
                    }
                });
                if (!r.ok) throw new Error(`HTTP ${r.status} for ${url(f.id, e.part)}`);
                let buf = new Uint8Array(await readDataResponse(r));
                F.fetched += buf.length;
                F.requests = (F.requests || 0) + 1;
                F.inflight--;
                F.fetchMs = (F.fetchMs || 0) + performance.now() - t0;
                if (window.uewStats) {
                    const st = F.per || (F.per = new Map), e = st.get(f.id) || {
                        n: 0,
                        bytes: 0,
                        uniq: new Set
                    };
                    e.n++;
                    e.bytes += buf.length;
                    e.uniq.add(b);
                    st.set(f.id, e);
                }
                if (!whole && r.status == 200) {
                    for (let i = 0; i < L.length; i++) if (i != b && L[i].part == e.part && !F.cache.has(key(f.id, i))) put(key(f.id, i), await unpack(f, i, buf.slice(L[i].off, L[i].off + L[i].len)));
                    buf = buf.slice(e.off, e.off + e.len);
                }
                return await unpack(f, b, buf);
            } catch (err_) {
                if (attempt >= 3) throw err_;
                await new Promise(r => setTimeout(r, 500 << attempt));
            }
        }
    }
    const block = (id, b) => {
        const k = key(id, b);
        const hit = get(k);
        if (hit) return hit;
        let p = F.pending.get(k);
        if (!p) {
            p = download(F.files[id], b).then(buf => {
                F.pending.delete(k);
                F.failed.delete(k);
                put(k, buf);
                Module.uewWake();
                return buf;
            }, e => {
                F.pending.delete(k);
                F.failed.add(k);
                Module.uewWake();
                throw e;
            });
            F.pending.set(k, p);
        }
        return p;
    };
    const blocks = (id, b0, b1) => {
        const f = F.files[id];
        if (f.stub || b1 <= b0) {
            for (let b = b0; b <= b1; b++) {
                const r = block(id, b);
                if (r instanceof Promise) r.catch(() => {});
            }
            return;
        }
        const L = layout(f);
        if (L.length == 1) {
            const r = block(id, b0);
            if (r instanceof Promise) r.catch(() => {});
            return;
        }
        let run = [];
        const go = () => {
            if (!run.length) return;
            const bs = run;
            run = [];
            if (bs.length == 1) {
                block(id, bs[0]).catch(() => {});
                return;
            }
            const first = L[bs[0]], lastE = L[bs[bs.length - 1]], from = first.off, to = lastE.off + lastE.len;
            const all = (async () => {
                for (let attempt = 0; ;attempt++) {
                    try {
                        const t0 = performance.now();
                        const r = await fetch(url(f.id, first.part), {
                            headers: {
                                Range: `bytes=${from}-${to - 1}`
                            }
                        });
                        if (r.status != 206) throw new Error(`HTTP ${r.status} for ${url(f.id, first.part)}`);
                        const buf = new Uint8Array(await readDataResponse(r));
                        F.fetched += buf.length;
                        F.requests = (F.requests || 0) + 1;
                        F.fetchMs = (F.fetchMs || 0) + performance.now() - t0;
                        if (window.uewStats) {
                            const st = F.per || (F.per = new Map), e = st.get(f.id) || {
                                n: 0,
                                bytes: 0,
                                uniq: new Set
                            };
                            e.n++;
                            e.bytes += buf.length;
                            for (const b of bs) e.uniq.add(b);
                            st.set(f.id, e);
                        }
                        return buf;
                    } catch (err_) {
                        if (attempt >= 3) throw err_;
                        await new Promise(r => setTimeout(r, 500 << attempt));
                    }
                }
            })();
            for (const b of bs) {
                const k = key(id, b), e = L[b];
                const pr = all.then(buf => unpack(f, b, buf.slice(e.off - from, e.off - from + e.len))).then(v => {
                    F.pending.delete(k);
                    F.failed.delete(k);
                    put(k, v);
                    Module.uewWake();
                    return v;
                }, e => {
                    F.pending.delete(k);
                    F.failed.add(k);
                    Module.uewWake();
                    throw e;
                });
                pr.catch(() => {});
                F.pending.set(k, pr);
            }
        };
        for (let b = b0; b <= b1; b++) {
            const k = key(id, b);
            if (F.cache.has(k) || F.pending.has(k)) {
                go();
                continue;
            }
            if (run.length && L[run[0]].part != L[b].part) go();
            run.push(b);
        }
        go();
    };
    const ahead = (id, off, len) => {
        const f = F.files[id], end = off + len;
        const seq = F.next.get(id) === off;
        F.next.set(id, end);
        if (!seq) return;
        const last = Math.floor((f.size - 1) / BLOCK), b = Math.floor(end / BLOCK);
        if (b <= last) blocks(id, b, Math.min(last, b + 7));
    };
    const T = {
        key: "",
        seen: new Set,
        order: [],
        rec: true,
        plan: [],
        pos: 0,
        q: [],
        qset: new Set
    };
    const pump = () => {
        while (T.pos < T.plan.length && T.q.length < 160) {
            const [id, b0, n] = T.plan[T.pos++];
            if (!F.files[id]) continue;
            const last = Math.floor((F.files[id].size - 1) / BLOCK), b1 = Math.min(last, b0 + n - 1);
            blocks(id, b0, b1);
            for (let b = b0; b <= b1; b++) {
                const k = key(id, b);
                if (!T.qset.has(k)) {
                    T.qset.add(k);
                    T.q.push(k);
                }
            }
        }
    };
    const touch = (id, b0, b1) => {
        for (let b = b0; b <= b1; b++) {
            const k = key(id, b);
            if (T.qset.has(k)) {
                let x;
                do {
                    x = T.q.shift();
                    T.qset.delete(x);
                } while (x !== k);
                pump();
            }
            if (T.rec && !T.seen.has(k)) {
                T.seen.add(k);
                T.order.push(k);
            }
        }
        if (T.rec && T.order.length > 2e4) save();
    };
    const save = () => {
        if (!T.rec) return;
        T.rec = false;
        const runs = [];
        for (const k of T.order) {
            const id = Math.floor(k / 1048576), b = k % 1048576, r = runs[runs.length - 1];
            if (r && r[0] === id && r[1] + r[2] === b) r[2]++; else runs.push([ id, b, 1 ]);
        }
        try {
            localStorage.setItem(T.key, runs.map(r => r.join(":")).join(","));
        } catch (e) {}
    };
    F.boot = () => {
        T.key = "uewBoot:" + location.pathname + ":" + F.files.length + ":" + F.files.reduce((a, f) => (a + f.size) % 1e15, 0);
        let saved = "";
        try {
            saved = localStorage.getItem(T.key) || "";
        } catch (e) {}
        T.plan = saved ? saved.split(",").map(r => r.split(":").map(Number)) : [];
        pump();
        const t = setInterval(() => {
            if ((Module.uewPresents | 0) >= 300) {
                clearInterval(t);
                save();
            }
        }, 1e3);
    };
    const copy = (bufs, b0, off, len, dst) => {
        let done = 0;
        for (let i = 0; i < bufs.length; i++) {
            const s = i ? 0 : off - b0 * BLOCK, n = Math.min(bufs[i].length - s, len - done);
            HEAPU8.set(bufs[i].subarray(s, s + n), dst + done >>> 0);
            done += n;
        }
        return done;
    };
    F.readCached = (id, off, len, dst) => {
        dst >>>= 0;
        if (!len) return 0;
        const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK), bufs = [];
        for (let b = b0; b <= b1; b++) {
            const v = get(key(id, b));
            if (!v) return -1;
            bufs.push(v);
        }
        touch(id, b0, b1);
        ahead(id, off, len);
        return copy(bufs, b0, off, len, dst);
    };
    F.failed = new Set;
    F.start = (id, off, len) => {
        const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
        const last = Math.floor((F.files[id].size - 1) / BLOCK);
        blocks(id, b0, Math.min(last, b1 + 7));
        touch(id, b0, b1);
        ahead(id, off, len);
    };
    F.ready = (id, off, len) => {
        const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
        for (let b = b0; b <= b1; b++) {
            const k = key(id, b);
            if (F.failed.has(k)) return 1;
            if (!get(k)) return 0;
        }
        return 1;
    };
    F.report = () => {
        const paths = new Map;
        for (const [p, f] of F.byPath) paths.set(f.id, p);
        return [ `boot plan ${T.plan.length} runs, at ${T.pos}, ${T.q.length} ahead, recorded ${T.order.length} blocks (${T.rec ? "still recording" : "saved"})`, `${F.requests} requests, ${(F.fetchMs / F.requests).toFixed(1)} ms each on average, up to ${F.maxInflight} at once` ].concat([ ...F.per || [] ].sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 15).map(([id, e]) => `${(e.bytes / 1048576).toFixed(0)} MB in ${e.n} (${e.uniq.size} distinct blocks of ${Math.ceil(F.files[id].size / BLOCK)}) ${paths.get(id)}`)).join("\n");
    };
    F.read = async (id, off, len, dst) => {
        dst >>>= 0;
        const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK), want = [];
        for (let b = b0; b <= b1; b++) want.push(block(id, b));
        touch(id, b0, b1);
        ahead(id, off, len);
        try {
            return copy(await Promise.all(want), b0, off, len, dst);
        } catch (e) {
            err(`[files] ${e.message}`);
            return -1;
        }
    };
    const index = fetch(F.base + "index.txt").then(r => r.ok ? r.text() : null).then(t => {
        if (t) {
            F.load(t);
            F.boot();
        } else err("[files] no data/index.txt, game files unavailable");
    }).catch(e => err(`[files] ${e.message}`));
    Module.preRun = [].concat(Module.preRun || []);
    Module.preRun.push(() => {
        addRunDependency("uew-files");
        index.finally(() => removeRunDependency("uew-files"));
    });
})();

(() => {
    const dir = Module.uewSave;
    if (!dir) return;
    let busy = false;
    const flush = () => {
        if (busy) return;
        busy = true;
        FS.syncfs(false, e => {
            busy = false;
            if (e) err(`[save] ${e}`);
        });
    };
    Module.preRun = [].concat(Module.preRun || []);
    Module.preRun.push(() => {
        FS.mkdirTree(dir);
        FS.mount(IDBFS, {}, dir);
        addRunDependency("uew-save");
        FS.syncfs(true, e => {
            if (e) err(`[save] ${e}`);
            const seed = typeof window !== "undefined" && window.uewSeedFiles;
            if (seed) for (const [rel, b64] of Object.entries(seed)) {
                const p = dir + "/" + rel, bin = atob(b64), a = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
                FS.mkdirTree(p.slice(0, p.lastIndexOf("/")));
                FS.writeFile(p, a);
            }
            removeRunDependency("uew-save");
            setInterval(flush, 5e3);
            addEventListener("pagehide", flush);
            addEventListener("visibilitychange", () => {
                if (document.visibilityState == "hidden") flush();
            });
        });
    });
})();

var programArgs = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
    throw toThrow;
};

var _scriptName = globalThis.document?.currentScript?.src;

if (typeof __filename !== "undefined") {
    _scriptName = __filename;
} else {}

var scriptDirectory = "";

function locateFile(path) {
    if (Module["locateFile"]) {
        return Module["locateFile"](path, scriptDirectory);
    }
    return scriptDirectory + path;
}

var readAsync, readBinary;

if (ENVIRONMENT_IS_NODE) {
    var fs = require("node:fs");
    scriptDirectory = __dirname + "/";
    readBinary = filename => {
        filename = isFileURI(filename) ? new URL(filename) : filename;
        var ret = fs.readFileSync(filename);
        return ret;
    };
    readAsync = async (filename, binary = true) => {
        filename = isFileURI(filename) ? new URL(filename) : filename;
        var ret = fs.readFileSync(filename, binary ? undefined : "utf8");
        return ret;
    };
    if (process.argv.length > 1) {
        thisProgram = process.argv[1].replace(/\\/g, "/");
    }
    programArgs = process.argv.slice(2);
    if (typeof module !== "undefined") {
        module["exports"] = Module;
    }
    quit_ = (status, toThrow) => {
        process.exitCode = status;
        throw toThrow;
    };
} else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
    try {
        scriptDirectory = new URL(".", _scriptName).href;
    } catch {}
    {
        readAsync = async url => {
            var response = await fetch(url, {
                credentials: "same-origin"
            });
            if (response.ok) {
                return response.arrayBuffer();
            }
            throw new Error(response.status + " : " + response.url);
        };
    }
} else {}

var out = console.log.bind(console);

var err = console.error.bind(console);

var wasmBinary;

var ABORT = false;

var EXITSTATUS;

function assert(condition, text) {
    if (!condition) {
        abort(text);
    }
}

var isFileURI = filename => filename.startsWith("file://");

class EmscriptenEH {}

var runtimeInitialized = false;

var runtimeExited = false;

function getMemoryBuffer() {
    return wasmMemory.buffer;
}

function updateMemoryViews() {
    if (HEAP8?.buffer?.resizable) return;
    var b = getMemoryBuffer();
    HEAP8 = new Int8Array(b);
    HEAP16 = new Int16Array(b);
    HEAPU8 = new Uint8Array(b);
    HEAPU16 = new Uint16Array(b);
    HEAP32 = new Int32Array(b);
    HEAPU32 = new Uint32Array(b);
    HEAPF32 = new Float32Array(b);
    HEAPF64 = new Float64Array(b);
    HEAP64 = new BigInt64Array(b);
}

function preRun() {
    var preRun = Module["preRun"];
    if (preRun) {
        if (typeof preRun === "function") preRun = [ preRun ];
        onPreRuns.push(...preRun);
    }
    callRuntimeCallbacks(onPreRuns);
}

function initRuntime() {
    runtimeInitialized = true;
    if (!Module["noFSInit"] && !FS.initialized) FS.init();
    TTY.init();
    wasmExports["__wasm_call_ctors"]();
    FS.ignorePermissions = false;
}

function exitRuntime() {
    ___funcs_on_exit();
    FS.quit();
    IDBFS.quit();
    TTY.shutdown();
    runtimeExited = true;
}

function postRun() {
    var postRun = Module["postRun"];
    if (postRun) {
        if (typeof postRun === "function") postRun = [ postRun ];
        onPostRuns.push(...postRun);
    }
    callRuntimeCallbacks(onPostRuns);
}

function abort(what) {
    Module["onAbort"]?.(what);
    what = `Aborted(${what})`;
    err(what);
    ABORT = true;
    what += ". Build with -sASSERTIONS for more info.";
    throw new WebAssembly.RuntimeError(what);
}

var wasmBinaryFile;

function findWasmBinary() {
    return locateFile("game.wasm");
}

function getBinarySync(file) {
    if (readBinary) {
        return readBinary(file);
    }
    throw "both async and sync fetching of the wasm failed";
}

async function getWasmBinary(binaryFile) {
    if (!wasmBinary) {
        try {
            return await readAsync(binaryFile);
        } catch {}
    }
    return getBinarySync(binaryFile);
}

async function instantiateArrayBuffer(binaryFile, imports) {
    try {
        var binary = await getWasmBinary(binaryFile);
        var instance = await WebAssembly.instantiate(binary, imports);
        return instance;
    } catch (reason) {
        err(`failed to asynchronously prepare wasm: ${reason}`);
        abort(reason);
    }
}

async function instantiateAsync(binary, binaryFile, imports) {
    if (!binary && !ENVIRONMENT_IS_NODE) {
        try {
            var response = fetch(binaryFile, {
                credentials: "same-origin"
            });
            var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
            return instantiationResult;
        } catch (reason) {
            err(`wasm streaming compile failed: ${reason}`);
            err("falling back to ArrayBuffer instantiation");
        }
    }
    return instantiateArrayBuffer(binaryFile, imports);
}

function getWasmImports() {
    Asyncify.instrumentWasmImports(wasmImports);
    var imports = {
        env: wasmImports,
        wasi_snapshot_preview1: wasmImports
    };
    return imports;
}

async function createWasm() {
    function receiveInstance(instance) {
        wasmExports = instance.exports;
        wasmExports = Asyncify.instrumentWasmExports(wasmExports);
        wasmExports = applySignatureConversions(wasmExports);
        assignWasmExports(wasmExports);
        updateMemoryViews();
        return wasmExports;
    }
    function receiveInstantiationResult(result) {
        return receiveInstance(result["instance"]);
    }
    var info = getWasmImports();
    var instantiateWasm = Module["instantiateWasm"];
    if (instantiateWasm) {
        return new Promise(resolve => {
            instantiateWasm(info, inst => resolve(receiveInstance(inst)));
        });
    }
    wasmBinaryFile ??= findWasmBinary();
    var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
    var exports = receiveInstantiationResult(result);
    return exports;
}

class ExitStatus {
    name="ExitStatus";
    constructor(status) {
        this.message = `Program terminated with exit(${status})`;
        this.status = status;
    }
}

var HEAP8;

var callRuntimeCallbacks = callbacks => {
    while (callbacks.length > 0) {
        callbacks.shift()(Module);
    }
};

var onPostRuns = [];

var addOnPostRun = cb => onPostRuns.push(cb);

var onPreRuns = [];

var addOnPreRun = cb => onPreRuns.push(cb);

var noExitRuntime = false;

const FS_MAX_OPEN_FDS = 4096;

var FS_createDataFile = (...args) => FS.createDataFile(...args);

var preloadPlugins = [];

var FS_handledByPreloadPlugin = async (byteArray, fullname) => {
    if (typeof Browser !== "undefined") Browser.init();
    for (var plugin of preloadPlugins) {
        if (plugin["canHandle"](fullname)) {
            return plugin["handle"](byteArray, fullname);
        }
    }
    return byteArray;
};

var PATH = {
    isAbs: path => path.charAt(0) === "/",
    splitPath: filename => {
        var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
        return splitPathRe.exec(filename).slice(1);
    },
    normalizeArray: (parts, allowAboveRoot) => {
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
            var last = parts[i];
            if (last === ".") {
                parts.splice(i, 1);
            } else if (last === "..") {
                parts.splice(i, 1);
                up++;
            } else if (up) {
                parts.splice(i, 1);
                up--;
            }
        }
        if (allowAboveRoot) {
            for (;up; up--) {
                parts.unshift("..");
            }
        }
        return parts;
    },
    normalize: path => {
        var isAbsolute = PATH.isAbs(path), trailingSlash = path.slice(-1) === "/";
        path = PATH.normalizeArray(path.split("/").filter(p => !!p), !isAbsolute).join("/");
        if (!path && !isAbsolute) {
            path = ".";
        }
        if (path && trailingSlash) {
            path += "/";
        }
        return (isAbsolute ? "/" : "") + path;
    },
    dirname: path => {
        var result = PATH.splitPath(path), root = result[0], dir = result[1];
        if (!root && !dir) {
            return ".";
        }
        if (dir) {
            dir = dir.slice(0, -1);
        }
        return root + dir;
    },
    basename: path => path && path.match(/([^\/]+|\/)\/*$/)[1],
    join: (...paths) => PATH.normalize(paths.join("/")),
    join2: (l, r) => PATH.normalize(l + "/" + r)
};

var PATH_FS = {
    resolve: (...args) => {
        var resolvedPath = "", resolvedAbsolute = false;
        for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
            var path = i >= 0 ? args[i] : FS.cwd();
            if (typeof path !== "string") {
                throw new TypeError("Arguments to path.resolve must be strings");
            } else if (!path) {
                return "";
            }
            resolvedPath = path + "/" + resolvedPath;
            resolvedAbsolute = PATH.isAbs(path);
        }
        resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter(p => !!p), !resolvedAbsolute).join("/");
        return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
    },
    relative: (from, to) => {
        from = PATH_FS.resolve(from).slice(1);
        to = PATH_FS.resolve(to).slice(1);
        function trim(arr) {
            var start = 0;
            for (;start < arr.length; start++) {
                if (arr[start] !== "") break;
            }
            var end = arr.length - 1;
            for (;end >= 0; end--) {
                if (arr[end] !== "") break;
            }
            if (start > end) return [];
            return arr.slice(start, end - start + 1);
        }
        var fromParts = trim(from.split("/"));
        var toParts = trim(to.split("/"));
        var length = Math.min(fromParts.length, toParts.length);
        var samePartsLength = length;
        for (var i = 0; i < length; i++) {
            if (fromParts[i] !== toParts[i]) {
                samePartsLength = i;
                break;
            }
        }
        var outputParts = [];
        for (var i = samePartsLength; i < fromParts.length; i++) {
            outputParts.push("..");
        }
        outputParts = outputParts.concat(toParts.slice(samePartsLength));
        return outputParts.join("/");
    }
};

var dependenciesPromise = null;

var dependenciesPromiseResolve = null;

var resolveRunDependencies = async () => dependenciesPromise;

var runDependencies = 0;

var removeRunDependency = id => {
    runDependencies--;
    Module["monitorRunDependencies"]?.(runDependencies);
    if (!runDependencies) {
        dependenciesPromiseResolve();
    }
};

var addRunDependency = id => {
    if (!runDependencies) {
        dependenciesPromise = new Promise(resolve => dependenciesPromiseResolve = resolve);
    }
    runDependencies++;
    Module["monitorRunDependencies"]?.(runDependencies);
};

var asyncLoad = async url => {
    var arrayBuffer = await readAsync(url);
    return new Uint8Array(arrayBuffer);
};

var getUniqueRunDependency = id => id;

var FS_preloadFile = async (parent, name, url, canRead = undefined, canWrite = undefined, dontCreateFile = undefined, canOwn = undefined, preFinish = undefined) => {
    var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
    var dep = getUniqueRunDependency(`cp ${fullname}`);
    addRunDependency(dep);
    try {
        var byteArray = url;
        if (typeof url === "string") {
            byteArray = await asyncLoad(url);
        }
        byteArray = await FS_handledByPreloadPlugin(byteArray, fullname);
        preFinish?.();
        if (!dontCreateFile) {
            FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
        }
    } finally {
        removeRunDependency(dep);
    }
};

var FS_createPreloadedFile = (parent, name, url, canRead = undefined, canWrite = undefined, onload = undefined, onerror = undefined, dontCreateFile = undefined, canOwn = undefined, preFinish = undefined) => {
    FS_preloadFile(parent, name, url, canRead, canWrite, dontCreateFile, canOwn, preFinish).then(onload).catch(onerror);
};

var lengthBytesUTF8 = str => {
    var len = 0;
    for (var i = 0; i < str.length; ++i) {
        var u = str.codePointAt(i);
        if (u <= 127) {
            len++;
        } else if (u <= 2047) {
            len += 2;
        } else if (u <= 65535) {
            len += 3;
        } else {
            len += 4;
            i++;
        }
    }
    return len;
};

var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
    outIdx >>>= 0;
    if (!(maxBytesToWrite > 0)) return 0;
    var startIdx = outIdx;
    var endIdx = outIdx + maxBytesToWrite - 1;
    for (var i = 0; i < str.length; ++i) {
        var u = str.codePointAt(i);
        if (u <= 127) {
            if (outIdx >= endIdx) break;
            heap[outIdx++ >>> 0] = u;
        } else if (u <= 2047) {
            if (outIdx + 1 >= endIdx) break;
            heap[outIdx++ >>> 0] = 192 | u >> 6;
            heap[outIdx++ >>> 0] = 128 | u & 63;
        } else if (u <= 65535) {
            if (outIdx + 2 >= endIdx) break;
            heap[outIdx++ >>> 0] = 224 | u >> 12;
            heap[outIdx++ >>> 0] = 128 | u >> 6 & 63;
            heap[outIdx++ >>> 0] = 128 | u & 63;
        } else {
            if (outIdx + 3 >= endIdx) break;
            heap[outIdx++ >>> 0] = 240 | u >> 18;
            heap[outIdx++ >>> 0] = 128 | u >> 12 & 63;
            heap[outIdx++ >>> 0] = 128 | u >> 6 & 63;
            heap[outIdx++ >>> 0] = 128 | u & 63;
            i++;
        }
    }
    heap[outIdx >>> 0] = 0;
    return outIdx - startIdx;
};

var intArrayFromString = (stringy, dontAddNull, length) => {
    var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
    var u8array = new Array(len);
    var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
    if (dontAddNull) u8array.length = numBytesWritten;
    return u8array;
};

var FS_fileDataToTypedArray = data => {
    if (typeof data === "string") {
        data = intArrayFromString(data, true);
    }
    if (!data.subarray) {
        data = new Uint8Array(data);
    }
    return data;
};

var FS_getMode = (canRead, canWrite) => {
    var mode = 0;
    if (canRead) mode |= 292 | 73;
    if (canWrite) mode |= 146;
    return mode;
};

var FS_modeStringToFlags = str => {
    if (typeof str !== "string") return str;
    var flagModes = {
        r: 0,
        "r+": 2,
        w: 512 | 64 | 1,
        "w+": 512 | 64 | 2,
        a: 1024 | 64 | 1,
        "a+": 1024 | 64 | 2
    };
    var flags = flagModes[str];
    if (typeof flags === "undefined") {
        throw new Error(`Unknown file open mode: ${str}`);
    }
    return flags;
};

const IDBFS_DB_STORE_NAME = "FILE_DATA";

const IDBFS_DB_VERSION = 21;

var mmapAlloc = size => {
    abort();
};

var MEMFS = {
    ops_table: null,
    mount(mount) {
        return MEMFS.createNode(null, "/", 16895, 0);
    },
    createNode(parent, name, mode, dev = undefined) {
        if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
            throw new FS.ErrnoError(63);
        }
        MEMFS.ops_table ||= {
            dir: {
                node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr,
                    lookup: MEMFS.node_ops.lookup,
                    mknod: MEMFS.node_ops.mknod,
                    rename: MEMFS.node_ops.rename,
                    unlink: MEMFS.node_ops.unlink,
                    rmdir: MEMFS.node_ops.rmdir,
                    readdir: MEMFS.node_ops.readdir,
                    symlink: MEMFS.node_ops.symlink
                },
                stream: {
                    llseek: MEMFS.stream_ops.llseek
                }
            },
            file: {
                node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr
                },
                stream: {
                    llseek: MEMFS.stream_ops.llseek,
                    read: MEMFS.stream_ops.read,
                    write: MEMFS.stream_ops.write,
                    mmap: MEMFS.stream_ops.mmap,
                    msync: MEMFS.stream_ops.msync
                }
            },
            link: {
                node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr,
                    readlink: MEMFS.node_ops.readlink
                },
                stream: {}
            },
            chrdev: {
                node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr
                },
                stream: FS.chrdev_stream_ops
            }
        };
        var node = FS.createNode(parent, name, mode, dev);
        if (FS.isDir(node.mode)) {
            node.node_ops = MEMFS.ops_table.dir.node;
            node.stream_ops = MEMFS.ops_table.dir.stream;
            node.contents = {};
        } else if (FS.isFile(node.mode)) {
            node.node_ops = MEMFS.ops_table.file.node;
            node.stream_ops = MEMFS.ops_table.file.stream;
            node.usedBytes = 0;
            node.contents = MEMFS.emptyFileContents ??= new Uint8Array(0);
        } else if (FS.isLink(node.mode)) {
            node.node_ops = MEMFS.ops_table.link.node;
            node.stream_ops = MEMFS.ops_table.link.stream;
        } else if (FS.isChrdev(node.mode)) {
            node.node_ops = MEMFS.ops_table.chrdev.node;
            node.stream_ops = MEMFS.ops_table.chrdev.stream;
        }
        node.atime = node.mtime = node.ctime = Date.now();
        if (parent) {
            parent.contents[name] = node;
            parent.atime = parent.mtime = parent.ctime = node.atime;
        }
        return node;
    },
    getFileDataAsTypedArray(node) {
        return node.contents.subarray(0, node.usedBytes);
    },
    expandFileStorage(node, newCapacity) {
        var prevCapacity = node.contents.length;
        if (prevCapacity >= newCapacity) return;
        const CAPACITY_DOUBLING_MAX = 1024 * 1024;
        newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) >>> 0);
        if (prevCapacity) newCapacity = Math.max(newCapacity, 256);
        var oldContents = MEMFS.getFileDataAsTypedArray(node);
        node.contents = new Uint8Array(newCapacity);
        node.contents.set(oldContents);
    },
    resizeFileStorage(node, newSize) {
        if (node.usedBytes == newSize) return;
        var oldContents = node.contents;
        node.contents = new Uint8Array(newSize);
        node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
        node.usedBytes = newSize;
    },
    node_ops: {
        getattr(node) {
            var attr = {};
            attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
            attr.ino = node.id;
            attr.mode = node.mode;
            attr.nlink = 1;
            attr.uid = 0;
            attr.gid = 0;
            attr.rdev = node.rdev;
            if (FS.isDir(node.mode)) {
                attr.size = 4096;
            } else if (FS.isFile(node.mode)) {
                attr.size = node.usedBytes;
            } else if (FS.isLink(node.mode)) {
                attr.size = node.link.length;
            } else {
                attr.size = 0;
            }
            attr.atime = new Date(node.atime);
            attr.mtime = new Date(node.mtime);
            attr.ctime = new Date(node.ctime);
            attr.blksize = 4096;
            attr.blocks = Math.ceil(attr.size / attr.blksize);
            return attr;
        },
        setattr(node, attr) {
            for (const key of [ "mode", "atime", "mtime", "ctime" ]) {
                if (attr[key] != null) {
                    node[key] = attr[key];
                }
            }
            if (attr.size !== undefined) {
                MEMFS.resizeFileStorage(node, attr.size);
            }
        },
        lookup(parent, name) {
            if (!MEMFS.doesNotExistError) {
                MEMFS.doesNotExistError = new FS.ErrnoError(44);
                MEMFS.doesNotExistError.stack = "<generic error, no stack>";
            }
            throw MEMFS.doesNotExistError;
        },
        mknod(parent, name, mode, dev = undefined) {
            return MEMFS.createNode(parent, name, mode, dev);
        },
        rename(old_node, new_dir, new_name) {
            var new_node;
            try {
                new_node = FS.lookupNode(new_dir, new_name);
            } catch (e) {}
            if (new_node && FS.isDir(old_node.mode)) {
                for (var i in new_node.contents) {
                    throw new FS.ErrnoError(55);
                }
            }
            delete old_node.parent.contents[old_node.name];
            new_dir.contents[new_name] = old_node;
            old_node.name = new_name;
            new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
        },
        unlink(parent, name) {
            delete parent.contents[name];
            parent.ctime = parent.mtime = Date.now();
        },
        rmdir(parent, name) {
            var node = FS.lookupNode(parent, name);
            for (var i in node.contents) {
                throw new FS.ErrnoError(55);
            }
            delete parent.contents[name];
            parent.ctime = parent.mtime = Date.now();
        },
        readdir(node) {
            return [ ".", "..", ...Object.keys(node.contents) ];
        },
        symlink(parent, newname, oldpath) {
            var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
            node.link = oldpath;
            return node;
        },
        readlink(node) {
            if (!FS.isLink(node.mode)) {
                throw new FS.ErrnoError(28);
            }
            return node.link;
        }
    },
    stream_ops: {
        read(stream, buffer, offset, length, position) {
            var contents = stream.node.contents;
            if (position >= stream.node.usedBytes) return 0;
            var size = Math.min(stream.node.usedBytes - position, length);
            buffer.set(contents.subarray(position, position + size), offset);
            return size;
        },
        write(stream, buffer, offset, length, position, canOwn) {
            if (buffer.buffer === HEAP8.buffer) {
                canOwn = false;
            }
            if (!length) return 0;
            var node = stream.node;
            node.mtime = node.ctime = Date.now();
            if (canOwn) {
                node.contents = buffer.subarray(offset, offset + length);
                node.usedBytes = length;
            } else if (!node.usedBytes && !position) {
                node.contents = buffer.slice(offset, offset + length);
                node.usedBytes = length;
            } else {
                MEMFS.expandFileStorage(node, position + length);
                node.contents.set(buffer.subarray(offset, offset + length), position);
                node.usedBytes = Math.max(node.usedBytes, position + length);
            }
            return length;
        },
        llseek(stream, offset, whence) {
            var position = offset;
            if (whence === 1) {
                position += stream.position;
            } else if (whence === 2) {
                if (FS.isFile(stream.node.mode)) {
                    position += stream.node.usedBytes;
                }
            }
            if (position < 0) {
                throw new FS.ErrnoError(28);
            }
            return position;
        },
        mmap(stream, length, position, prot, flags) {
            if (!FS.isFile(stream.node.mode)) {
                throw new FS.ErrnoError(43);
            }
            var ptr;
            var allocated;
            var contents = stream.node.contents;
            if (!(flags & 2) && contents.buffer === HEAP8.buffer) {
                allocated = false;
                ptr = contents.byteOffset;
            } else {
                allocated = true;
                ptr = mmapAlloc(length);
                if (!ptr) {
                    throw new FS.ErrnoError(48);
                }
                if (contents) {
                    if (position > 0 || position + length < contents.length) {
                        if (contents.subarray) {
                            contents = contents.subarray(position, position + length);
                        } else {
                            contents = contents.slice(position, position + length);
                        }
                    }
                    HEAP8.set(contents, ptr >>> 0);
                }
            }
            return {
                ptr: ptr,
                allocated: allocated
            };
        },
        msync(stream, buffer, offset, length, mmapFlags) {
            MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
            return 0;
        }
    }
};

var IDBFS = {
    dbs: {},
    indexedDB: () => indexedDB,
    queuePersist: mount => {
        function onPersistComplete() {
            if (mount.idbPersistState === "again") startPersist(); else {
                mount.idbPersistState = 0;
                IDBFS.onAutoPersistStateChanged?.(false);
            }
        }
        function startPersist() {
            mount.idbPersistState = "idb";
            IDBFS.onAutoPersistStateChanged?.(true);
            IDBFS.syncfs(mount, false, onPersistComplete);
        }
        if (!mount.idbPersistState) {
            mount.idbPersistState = setTimeout(startPersist, 0);
        } else if (mount.idbPersistState === "idb") {
            mount.idbPersistState = "again";
        }
    },
    mount: mount => {
        var mnt = MEMFS.mount(mount);
        if (mount?.opts?.autoPersist) {
            mount.idbPersistState = 0;
            var memfs_node_ops = mnt.node_ops;
            mnt.node_ops = {
                ...mnt.node_ops
            };
            mnt.node_ops.mknod = (parent, name, mode, dev) => {
                var node = memfs_node_ops.mknod(parent, name, mode, dev);
                node.node_ops = mnt.node_ops;
                node.idbfs_mount = mnt.mount;
                node.memfs_stream_ops = node.stream_ops;
                node.stream_ops = {
                    ...node.stream_ops
                };
                node.stream_ops.write = (stream, buffer, offset, length, position, canOwn) => {
                    stream.node.isModified = true;
                    return node.memfs_stream_ops.write(stream, buffer, offset, length, position, canOwn);
                };
                node.stream_ops.close = stream => {
                    var n = stream.node;
                    if (n.isModified) {
                        IDBFS.queuePersist(n.idbfs_mount);
                        n.isModified = false;
                    }
                    if (n.memfs_stream_ops.close) return n.memfs_stream_ops.close(stream);
                };
                IDBFS.queuePersist(mnt.mount);
                return node;
            };
            mnt.node_ops.rmdir = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.rmdir(...args));
            mnt.node_ops.symlink = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.symlink(...args));
            mnt.node_ops.unlink = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.unlink(...args));
            mnt.node_ops.rename = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.rename(...args));
        }
        return mnt;
    },
    syncfs: (mount, populate, callback) => {
        IDBFS.getLocalSet(mount, (err, local) => {
            if (err) return callback(err);
            IDBFS.getRemoteSet(mount, (err, remote) => {
                if (err) return callback(err);
                var src = populate ? remote : local;
                var dst = populate ? local : remote;
                IDBFS.reconcile(src, dst, callback);
            });
        });
    },
    quit: () => {
        for (var value of Object.values(IDBFS.dbs)) {
            value.close();
        }
        IDBFS.dbs = {};
    },
    getDB: (name, callback) => {
        var db = IDBFS.dbs[name];
        if (db) {
            return callback(null, db);
        }
        var req;
        try {
            req = IDBFS.indexedDB().open(name, IDBFS_DB_VERSION);
        } catch (e) {
            return callback(e);
        }
        if (!req) {
            return callback("Unable to connect to IndexedDB");
        }
        req.onupgradeneeded = e => {
            var db = e.target.result;
            var transaction = e.target.transaction;
            var fileStore;
            if (db.objectStoreNames.contains(IDBFS_DB_STORE_NAME)) {
                fileStore = transaction.objectStore(IDBFS_DB_STORE_NAME);
            } else {
                fileStore = db.createObjectStore(IDBFS_DB_STORE_NAME);
            }
            if (!fileStore.indexNames.contains("timestamp")) {
                fileStore.createIndex("timestamp", "timestamp", {
                    unique: false
                });
            }
        };
        req.onsuccess = () => {
            db = req.result;
            IDBFS.dbs[name] = db;
            callback(null, db);
        };
        req.onerror = e => {
            callback(e.target.error);
            e.preventDefault();
        };
    },
    getLocalSet: (mount, callback) => {
        var entries = {};
        function isRealDir(p) {
            return p !== "." && p !== "..";
        }
        function toAbsolute(root) {
            return p => PATH.join2(root, p);
        }
        var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
        while (check.length) {
            var path = check.pop();
            var stat;
            try {
                stat = FS.lstat(path);
            } catch (e) {
                return callback(e);
            }
            if (FS.isDir(stat.mode)) {
                check.push(...FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
            }
            entries[path] = {
                timestamp: stat.mtime
            };
        }
        return callback(null, {
            type: "local",
            entries: entries
        });
    },
    getRemoteSet: (mount, callback) => {
        var entries = {};
        IDBFS.getDB(mount.mountpoint, (err, db) => {
            if (err) return callback(err);
            try {
                var transaction = db.transaction([ IDBFS_DB_STORE_NAME ], "readonly");
                transaction.onerror = e => {
                    callback(e.target.error);
                    e.preventDefault();
                };
                var store = transaction.objectStore(IDBFS_DB_STORE_NAME);
                var index = store.index("timestamp");
                index.openKeyCursor().onsuccess = event => {
                    var cursor = event.target.result;
                    if (!cursor) {
                        return callback(null, {
                            type: "remote",
                            db: db,
                            entries: entries
                        });
                    }
                    entries[cursor.primaryKey] = {
                        timestamp: cursor.key
                    };
                    cursor.continue();
                };
            } catch (e) {
                return callback(e);
            }
        });
    },
    loadLocalEntry: (path, callback) => {
        var stat, node;
        try {
            var lookup = FS.lookupPath(path);
            node = lookup.node;
            stat = FS.lstat(path);
        } catch (e) {
            return callback(e);
        }
        if (FS.isDir(stat.mode)) {
            return callback(null, {
                timestamp: stat.mtime,
                mode: stat.mode
            });
        } else if (FS.isLink(stat.mode)) {
            return callback(null, {
                timestamp: stat.mtime,
                mode: stat.mode,
                link: node.link
            });
        } else if (FS.isFile(stat.mode)) {
            node.contents = MEMFS.getFileDataAsTypedArray(node);
            return callback(null, {
                timestamp: stat.mtime,
                mode: stat.mode,
                contents: node.contents
            });
        } else {
            return callback(new Error("node type not supported"));
        }
    },
    storeLocalEntry: (path, entry, callback) => {
        try {
            if (FS.isDir(entry["mode"])) {
                FS.mkdirTree(path, entry["mode"]);
            } else if (FS.isLink(entry["mode"])) {
                FS.symlink(entry["link"], path);
            } else if (FS.isFile(entry["mode"])) {
                FS.writeFile(path, entry["contents"], {
                    canOwn: true
                });
            } else {
                return callback(new Error("node type not supported"));
            }
            FS.chmod(path, entry["mode"]);
            FS.utime(path, entry["timestamp"], entry["timestamp"]);
        } catch (e) {
            return callback(e);
        }
        callback(null);
    },
    removeLocalEntry: (path, callback) => {
        try {
            var stat = FS.lstat(path);
            if (FS.isDir(stat.mode)) {
                FS.rmdir(path);
            } else {
                FS.unlink(path);
            }
        } catch (e) {
            return callback(e);
        }
        callback(null);
    },
    loadRemoteEntry: (store, path, callback) => {
        var req = store.get(path);
        req.onsuccess = event => callback(null, event.target.result);
        req.onerror = e => {
            callback(e.target.error);
            e.preventDefault();
        };
    },
    storeRemoteEntry: (store, path, entry, callback) => {
        try {
            var req = store.put(entry, path);
        } catch (e) {
            callback(e);
            return;
        }
        req.onsuccess = event => callback();
        req.onerror = e => {
            callback(e.target.error);
            e.preventDefault();
        };
    },
    removeRemoteEntry: (store, path, callback) => {
        var req = store.delete(path);
        req.onsuccess = event => callback();
        req.onerror = e => {
            callback(e.target.error);
            e.preventDefault();
        };
    },
    reconcile: (src, dst, callback) => {
        var total = 0;
        var create = [];
        for (var [key, e] of Object.entries(src.entries)) {
            var e2 = dst.entries[key];
            if (!e2 || e["timestamp"].getTime() != e2["timestamp"].getTime()) {
                create.push(key);
                total++;
            }
        }
        var remove = [];
        for (var key of Object.keys(dst.entries)) {
            if (!src.entries[key]) {
                remove.push(key);
                total++;
            }
        }
        if (!total) {
            return callback(null);
        }
        var errored = false;
        var db = src.type === "remote" ? src.db : dst.db;
        var transaction = db.transaction([ IDBFS_DB_STORE_NAME ], "readwrite");
        var store = transaction.objectStore(IDBFS_DB_STORE_NAME);
        function done(err) {
            if (err && !errored) {
                errored = true;
                return callback(err);
            }
        }
        transaction.onerror = transaction.onabort = e => {
            done(e.target.error);
            e.preventDefault();
        };
        transaction.oncomplete = e => {
            if (!errored) {
                callback(null);
            }
        };
        for (const path of create.sort()) {
            if (dst.type === "local") {
                IDBFS.loadRemoteEntry(store, path, (err, entry) => {
                    if (err) return done(err);
                    IDBFS.storeLocalEntry(path, entry, done);
                });
            } else {
                IDBFS.loadLocalEntry(path, (err, entry) => {
                    if (err) return done(err);
                    IDBFS.storeRemoteEntry(store, path, entry, done);
                });
            }
        }
        for (var path of remove.sort().reverse()) {
            if (dst.type === "local") {
                IDBFS.removeLocalEntry(path, done);
            } else {
                IDBFS.removeRemoteEntry(store, path, done);
            }
        }
    }
};

var FS_stdin_getChar_buffer = [];

var FS_stdin_getChar = () => {
    if (!FS_stdin_getChar_buffer.length) {
        var result = null;
        if (ENVIRONMENT_IS_NODE) {
            var BUFSIZE = 256;
            var buf = Buffer.alloc(BUFSIZE);
            var bytesRead = 0;
            try {
                bytesRead = fs.readSync(process.stdin.fd, buf, 0, BUFSIZE);
            } catch (e) {
                if (e.toString().includes("EOF")) bytesRead = 0; else throw e;
            }
            if (bytesRead > 0) {
                result = buf.toString("utf-8", 0, bytesRead);
            }
        } else if (globalThis.window?.prompt) {
            result = window.prompt("Input: ");
            if (result !== null) {
                result += "\n";
            }
        } else {}
        if (!result) {
            return null;
        }
        FS_stdin_getChar_buffer = intArrayFromString(result, true);
    }
    return FS_stdin_getChar_buffer.shift();
};

var UTF8Decoder = globalThis.TextDecoder && new TextDecoder;

var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
    var maxIdx = idx + maxBytesToRead;
    if (ignoreNul) return maxIdx;
    while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
    return idx;
};

var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
    idx >>>= 0;
    var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
    if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
        return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
    }
    var str = "";
    while (idx < endPtr) {
        var u0 = heapOrArray[idx++];
        if (!(u0 & 128)) {
            str += String.fromCharCode(u0);
            continue;
        }
        var u1 = heapOrArray[idx++] & 63;
        if ((u0 & 224) == 192) {
            str += String.fromCharCode((u0 & 31) << 6 | u1);
            continue;
        }
        var u2 = heapOrArray[idx++] & 63;
        if ((u0 & 240) == 224) {
            u0 = (u0 & 15) << 12 | u1 << 6 | u2;
        } else {
            u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
        }
        if (u0 < 65536) {
            str += String.fromCharCode(u0);
        } else {
            var ch = u0 - 65536;
            str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
        }
    }
    return str;
};

var TTY = {
    ttys: [],
    init() {},
    shutdown() {},
    register(dev, ops) {
        TTY.ttys[dev] = {
            input: [],
            output: [],
            ops: ops
        };
        FS.registerDevice(dev, TTY.stream_ops);
    },
    stream_ops: {
        open(stream) {
            var tty = TTY.ttys[stream.node.rdev];
            if (!tty) {
                throw new FS.ErrnoError(43);
            }
            stream.tty = tty;
            stream.seekable = false;
        },
        close(stream) {
            stream.tty.ops.fsync(stream.tty);
        },
        fsync(stream) {
            stream.tty.ops.fsync(stream.tty);
        },
        read(stream, buffer, offset, length, pos) {
            if (!stream.tty || !stream.tty.ops.get_char) {
                throw new FS.ErrnoError(60);
            }
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
                var result;
                try {
                    result = stream.tty.ops.get_char(stream.tty);
                } catch (e) {
                    throw new FS.ErrnoError(29);
                }
                if (result === undefined && !bytesRead) {
                    throw new FS.ErrnoError(6);
                }
                if (result === null || result === undefined) break;
                bytesRead++;
                buffer[offset + i] = result;
                if (result === 10) break;
            }
            if (bytesRead) {
                stream.node.atime = Date.now();
            }
            return bytesRead;
        },
        write(stream, buffer, offset, length, pos) {
            if (!stream.tty || !stream.tty.ops.put_char) {
                throw new FS.ErrnoError(60);
            }
            try {
                for (var i = 0; i < length; i++) {
                    stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
                }
            } catch (e) {
                throw new FS.ErrnoError(29);
            }
            if (length) {
                stream.node.mtime = stream.node.ctime = Date.now();
            }
            return i;
        }
    },
    default_tty_ops: {
        get_char(tty) {
            return FS_stdin_getChar();
        },
        put_char(tty, val) {
            if (val === null || val === 10) {
                out(UTF8ArrayToString(tty.output));
                tty.output = [];
            } else {
                if (val != 0) tty.output.push(val);
            }
        },
        fsync(tty) {
            if (tty.output?.length > 0) {
                out(UTF8ArrayToString(tty.output));
                tty.output = [];
            }
        },
        ioctl_tcgets(tty) {
            return {
                c_iflag: 25856,
                c_oflag: 5,
                c_cflag: 191,
                c_lflag: 35387,
                c_cc: [ 3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ]
            };
        },
        ioctl_tcsets(tty, optional_actions, data) {
            return 0;
        },
        ioctl_tiocgwinsz(tty) {
            return [ 24, 80 ];
        }
    },
    default_tty1_ops: {
        put_char(tty, val) {
            if (val === null || val === 10) {
                err(UTF8ArrayToString(tty.output));
                tty.output = [];
            } else {
                if (val != 0) tty.output.push(val);
            }
        },
        fsync(tty) {
            if (tty.output?.length > 0) {
                err(UTF8ArrayToString(tty.output));
                tty.output = [];
            }
        }
    }
};

var initRandomFill = () => {
    if (ENVIRONMENT_IS_NODE) {
        var nodeCrypto = require("node:crypto");
        return view => (nodeCrypto.randomFillSync(view), 0);
    }
    return view => (crypto.getRandomValues(view), 0);
};

var randomFill = view => (randomFill = initRandomFill())(view);

var FS = {
    root: null,
    mounts: [],
    devices: {},
    streams: [],
    nextInode: 1,
    nameTable: [],
    currentPath: "/",
    initialized: false,
    ignorePermissions: true,
    syncFSRequests: 0,
    ErrnoError: class {
        name="ErrnoError";
        constructor(errno) {
            this.errno = errno;
        }
    },
    FSStream: class {
        shared={};
        get object() {
            return this.node;
        }
        set object(val) {
            this.node = val;
        }
        get isRead() {
            return (this.flags & 2097155) !== 1;
        }
        get isWrite() {
            return (this.flags & 2097155) !== 0;
        }
        get isAppend() {
            return this.flags & 1024;
        }
        get flags() {
            return this.shared.flags;
        }
        set flags(val) {
            this.shared.flags = val;
        }
        get position() {
            return this.shared.position;
        }
        set position(val) {
            this.shared.position = val;
        }
    },
    FSNode: class {
        node_ops={};
        stream_ops={};
        readMode=292 | 73;
        writeMode=146;
        mounted=null;
        constructor(parent, name, mode, rdev) {
            if (!parent) {
                parent = this;
            }
            this.parent = parent;
            this.mount = parent.mount;
            this.id = FS.nextInode++;
            this.name = name;
            this.mode = mode;
            this.rdev = rdev;
            this.atime = this.mtime = this.ctime = Date.now();
        }
        get read() {
            return (this.mode & this.readMode) === this.readMode;
        }
        set read(val) {
            val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
        }
        get write() {
            return (this.mode & this.writeMode) === this.writeMode;
        }
        set write(val) {
            val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
        }
        get isFolder() {
            return FS.isDir(this.mode);
        }
        get isDevice() {
            return FS.isChrdev(this.mode);
        }
        addListener(cb, exclusive = false) {
            var entry = {
                cb: cb,
                exclusive: exclusive
            };
            var listeners = this.listeners ??= new Set;
            listeners.add(entry);
            return {
                listeners: listeners,
                entry: entry
            };
        }
        notifyListeners(flags) {
            if (!this.listeners) return;
            var excl;
            for (var entry of this.listeners) {
                if (entry.exclusive) (excl ||= []).push(entry); else entry.cb(flags);
            }
            if (excl) {
                var i = (this.exclTurn || 0) % excl.length;
                this.exclTurn = i + 1;
                excl[i].cb(flags);
            }
        }
    },
    lookupPath(path, opts = {}) {
        if (!path) {
            throw new FS.ErrnoError(44);
        }
        opts.follow_mount ??= true;
        if (!PATH.isAbs(path)) {
            path = FS.cwd() + "/" + path;
        }
        linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
            var parts = path.split("/").filter(p => !!p);
            var current = FS.root;
            var current_path = "/";
            for (var i = 0; i < parts.length; i++) {
                var islast = i === parts.length - 1;
                if (islast && opts.parent) {
                    break;
                }
                if (parts[i] === ".") {
                    continue;
                }
                if (parts[i] === "..") {
                    current_path = PATH.dirname(current_path);
                    if (FS.isRoot(current)) {
                        path = current_path + "/" + parts.slice(i + 1).join("/");
                        nlinks--;
                        continue linkloop;
                    } else {
                        current = current.parent;
                    }
                    continue;
                }
                current_path = PATH.join2(current_path, parts[i]);
                try {
                    current = FS.lookupNode(current, parts[i]);
                } catch (e) {
                    if (e?.errno === 44 && islast && opts.noent_okay) {
                        return {
                            path: current_path
                        };
                    }
                    throw e;
                }
                if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
                    current = current.mounted.root;
                }
                if (FS.isLink(current.mode) && (!islast || opts.follow)) {
                    if (!current.node_ops.readlink) {
                        throw new FS.ErrnoError(52);
                    }
                    var link = current.node_ops.readlink(current);
                    if (!PATH.isAbs(link)) {
                        link = PATH.dirname(current_path) + "/" + link;
                    }
                    path = link + "/" + parts.slice(i + 1).join("/");
                    continue linkloop;
                }
            }
            return {
                path: current_path,
                node: current
            };
        }
        throw new FS.ErrnoError(32);
    },
    getPath(node) {
        var path;
        while (true) {
            if (FS.isRoot(node)) {
                var mount = node.mount.mountpoint;
                if (!path) return mount;
                return mount[mount.length - 1] !== "/" ? `${mount}/${path}` : mount + path;
            }
            path = path ? `${node.name}/${path}` : node.name;
            node = node.parent;
        }
    },
    hashName(parentid, name) {
        var hash = 0;
        for (var i = 0; i < name.length; i++) {
            hash = (hash << 5) - hash + name.charCodeAt(i) | 0;
        }
        return (parentid + hash >>> 0) % FS.nameTable.length;
    },
    hashAddNode(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        node.name_next = FS.nameTable[hash];
        FS.nameTable[hash] = node;
    },
    hashRemoveNode(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        if (FS.nameTable[hash] === node) {
            FS.nameTable[hash] = node.name_next;
        } else {
            var current = FS.nameTable[hash];
            while (current) {
                if (current.name_next === node) {
                    current.name_next = node.name_next;
                    break;
                }
                current = current.name_next;
            }
        }
    },
    lookupNode(parent, name) {
        var errCode = FS.mayLookup(parent);
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        var hash = FS.hashName(parent.id, name);
        for (var node = FS.nameTable[hash]; node; node = node.name_next) {
            var nodeName = node.name;
            if (node.parent.id === parent.id && nodeName === name) {
                return node;
            }
        }
        return FS.lookup(parent, name);
    },
    createNode(parent, name, mode, rdev = undefined) {
        var node = new FS.FSNode(parent, name, mode, rdev);
        FS.hashAddNode(node);
        return node;
    },
    destroyNode(node) {
        FS.hashRemoveNode(node);
    },
    isRoot(node) {
        return node === node.parent;
    },
    isMountpoint(node) {
        return !!node.mounted;
    },
    isFile(mode) {
        return (mode & 61440) === 32768;
    },
    isDir(mode) {
        return (mode & 61440) === 16384;
    },
    isLink(mode) {
        return (mode & 61440) === 40960;
    },
    isChrdev(mode) {
        return (mode & 61440) === 8192;
    },
    isBlkdev(mode) {
        return (mode & 61440) === 24576;
    },
    isFIFO(mode) {
        return (mode & 61440) === 4096;
    },
    isSocket(mode) {
        return (mode & 49152) === 49152;
    },
    flagsToPermissionString(flag) {
        var perms = [ "r", "w", "rw" ][flag & 3];
        if (flag & 512) {
            perms += "w";
        }
        return perms;
    },
    nodePermissions(node, perms) {
        if (FS.ignorePermissions) {
            return 0;
        }
        if (perms.includes("r") && !(node.mode & 292)) {
            return 2;
        }
        if (perms.includes("w") && !(node.mode & 146)) {
            return 2;
        }
        if (perms.includes("x") && !(node.mode & 73)) {
            return 2;
        }
        return 0;
    },
    mayLookup(dir) {
        if (!FS.isDir(dir.mode)) return 54;
        var errCode = FS.nodePermissions(dir, "x");
        if (errCode) return errCode;
        if (!dir.node_ops.lookup) return 2;
        return 0;
    },
    mayCreate(dir, name) {
        if (!FS.isDir(dir.mode)) {
            return 54;
        }
        try {
            var node = FS.lookupNode(dir, name);
            return 20;
        } catch (e) {}
        return FS.nodePermissions(dir, "wx");
    },
    mayDelete(dir, name, isdir) {
        var node;
        try {
            node = FS.lookupNode(dir, name);
        } catch (e) {
            return e.errno;
        }
        var errCode = FS.nodePermissions(dir, "wx");
        if (errCode) {
            return errCode;
        }
        if (isdir) {
            if (!FS.isDir(node.mode)) {
                return 54;
            }
            if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
                return 10;
            }
        } else if (FS.isDir(node.mode)) {
            return 31;
        }
        return 0;
    },
    mayOpen(node, flags) {
        if (!node) {
            return 44;
        }
        if (FS.isLink(node.mode)) {
            return 32;
        }
        var mode = FS.flagsToPermissionString(flags);
        if (FS.isDir(node.mode)) {
            if (mode !== "r" || flags & (512 | 64)) {
                return 31;
            }
        }
        return FS.nodePermissions(node, mode);
    },
    checkOpExists(op, err) {
        if (!op) {
            throw new FS.ErrnoError(err);
        }
        return op;
    },
    nextfd() {
        for (var fd = 0; fd <= FS_MAX_OPEN_FDS; fd++) {
            if (!FS.streams[fd]) {
                return fd;
            }
        }
        throw new FS.ErrnoError(33);
    },
    getStreamChecked(fd) {
        var stream = FS.getStream(fd);
        if (!stream) {
            throw new FS.ErrnoError(8);
        }
        return stream;
    },
    getStream: fd => FS.streams[fd],
    createStream(stream, fd = -1) {
        stream = Object.assign(new FS.FSStream, stream);
        if (fd == -1) {
            fd = FS.nextfd();
        }
        stream.fd = fd;
        FS.streams[fd] = stream;
        return stream;
    },
    closeStream(fd) {
        FS.streams[fd] = null;
    },
    dupStream(origStream, fd = -1) {
        var stream = FS.createStream(origStream, fd);
        stream.stream_ops?.dup?.(stream);
        return stream;
    },
    doSetAttr(stream, node, attr) {
        var setattr = stream?.stream_ops.setattr;
        var arg = setattr ? stream : node;
        setattr ??= node.node_ops.setattr;
        FS.checkOpExists(setattr, 63);
        try {
            setattr(arg, attr);
        } catch (e) {
            if (e instanceof RangeError) {
                throw new FS.ErrnoError(22);
            }
            throw e;
        }
    },
    chrdev_stream_ops: {
        open(stream) {
            var device = FS.getDevice(stream.node.rdev);
            stream.stream_ops = device.stream_ops;
            stream.stream_ops.open?.(stream);
        },
        llseek() {
            throw new FS.ErrnoError(70);
        }
    },
    major: dev => dev >> 8,
    minor: dev => dev & 255,
    makedev: (ma, mi) => ma << 8 | mi,
    registerDevice(dev, ops) {
        FS.devices[dev] = {
            stream_ops: ops
        };
    },
    getDevice: dev => FS.devices[dev],
    getMounts(mount) {
        var mounts = [];
        var check = [ mount ];
        while (check.length) {
            var m = check.pop();
            mounts.push(m);
            check.push(...m.mounts);
        }
        return mounts;
    },
    syncfs(populate, callback) {
        if (typeof populate === "function") {
            callback = populate;
            populate = false;
        }
        FS.syncFSRequests++;
        if (FS.syncFSRequests > 1) {
            err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
        }
        var mounts = FS.getMounts(FS.root.mount);
        var completed = 0;
        function doCallback(errCode) {
            FS.syncFSRequests--;
            return callback(errCode);
        }
        function done(errCode) {
            if (errCode) {
                if (!done.errored) {
                    done.errored = true;
                    return doCallback(errCode);
                }
                return;
            }
            if (++completed >= mounts.length) {
                doCallback(null);
            }
        }
        for (var mount of mounts) {
            if (mount.type.syncfs) {
                mount.type.syncfs(mount, populate, done);
            } else {
                done(null);
            }
        }
    },
    mount(type, opts, mountpoint) {
        var root = mountpoint === "/";
        var pseudo = !mountpoint;
        var node;
        if (root && FS.root) {
            throw new FS.ErrnoError(10);
        } else if (!root && !pseudo) {
            var lookup = FS.lookupPath(mountpoint, {
                follow_mount: false
            });
            mountpoint = lookup.path;
            node = lookup.node;
            if (FS.isMountpoint(node)) {
                throw new FS.ErrnoError(10);
            }
            if (!FS.isDir(node.mode)) {
                throw new FS.ErrnoError(54);
            }
        }
        var mount = {
            type: type,
            opts: opts,
            mountpoint: mountpoint,
            mounts: []
        };
        var mountRoot = type.mount(mount);
        mountRoot.mount = mount;
        mount.root = mountRoot;
        if (root) {
            FS.root = mountRoot;
        } else if (node) {
            node.mounted = mount;
            if (node.mount) {
                node.mount.mounts.push(mount);
            }
        }
        return mountRoot;
    },
    unmount(mountpoint) {
        var lookup = FS.lookupPath(mountpoint, {
            follow_mount: false
        });
        if (!FS.isMountpoint(lookup.node)) {
            throw new FS.ErrnoError(28);
        }
        var node = lookup.node;
        var mount = node.mounted;
        var mounts = FS.getMounts(mount);
        for (var [hash, current] of Object.entries(FS.nameTable)) {
            while (current) {
                var next = current.name_next;
                if (mounts.includes(current.mount)) {
                    FS.destroyNode(current);
                }
                current = next;
            }
        }
        node.mounted = null;
        var idx = node.mount.mounts.indexOf(mount);
        node.mount.mounts.splice(idx, 1);
    },
    lookup(parent, name) {
        return parent.node_ops.lookup(parent, name);
    },
    mknod(path, mode, dev) {
        var lookup = FS.lookupPath(path, {
            parent: true
        });
        var parent = lookup.node;
        var name = PATH.basename(path);
        if (!name) {
            throw new FS.ErrnoError(28);
        }
        if (name === "." || name === "..") {
            throw new FS.ErrnoError(20);
        }
        var errCode = FS.mayCreate(parent, name);
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.mknod) {
            throw new FS.ErrnoError(63);
        }
        return parent.node_ops.mknod(parent, name, mode, dev);
    },
    statfs(path) {
        return FS.statfsNode(FS.lookupPath(path, {
            follow: true
        }).node);
    },
    statfsStream(stream) {
        return FS.statfsNode(stream.node);
    },
    statfsNode(node) {
        var rtn = {
            bsize: 4096,
            frsize: 4096,
            blocks: 1e6,
            bfree: 5e5,
            bavail: 5e5,
            files: FS.nextInode,
            ffree: FS.nextInode - 1,
            fsid: 42,
            flags: 2,
            namelen: 255
        };
        if (node.node_ops.statfs) {
            Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
        }
        return rtn;
    },
    create(path, mode = 438) {
        mode &= 4095;
        mode |= 32768;
        return FS.mknod(path, mode, 0);
    },
    mkdir(path, mode = 511) {
        mode &= 511 | 512;
        mode |= 16384;
        return FS.mknod(path, mode, 0);
    },
    mkdirTree(path, mode = 511) {
        var dirs = path.split("/");
        var d = "";
        for (var dir of dirs) {
            if (!dir) continue;
            if (d || PATH.isAbs(path)) d += "/";
            d += dir;
            try {
                FS.mkdir(d, mode);
            } catch (e) {
                if (e.errno != 20) throw e;
            }
        }
    },
    mkdev(path, mode, dev = undefined) {
        if (typeof dev === "undefined") {
            dev = mode;
            mode = 438;
        }
        mode |= 8192;
        return FS.mknod(path, mode, dev);
    },
    symlink(oldpath, newpath) {
        if (!PATH_FS.resolve(oldpath)) {
            throw new FS.ErrnoError(44);
        }
        var lookup = FS.lookupPath(newpath, {
            parent: true
        });
        var parent = lookup.node;
        if (!parent) {
            throw new FS.ErrnoError(44);
        }
        var newname = PATH.basename(newpath);
        var errCode = FS.mayCreate(parent, newname);
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.symlink) {
            throw new FS.ErrnoError(63);
        }
        return parent.node_ops.symlink(parent, newname, oldpath);
    },
    link(oldpath, newpath, flags) {
        var lookup = FS.lookupPath(newpath, {
            parent: true
        });
        var parent = lookup.node;
        if (!parent) {
            throw new FS.ErrnoError(44);
        }
        var newname = PATH.basename(newpath);
        var errCode = FS.mayCreate(parent, newname);
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.link) {
            throw new FS.ErrnoError(34);
        }
        return parent.node_ops.link(parent, newname, oldpath, flags);
    },
    rename(old_path, new_path) {
        var old_dirname = PATH.dirname(old_path);
        var new_dirname = PATH.dirname(new_path);
        var old_name = PATH.basename(old_path);
        var new_name = PATH.basename(new_path);
        var lookup, old_dir, new_dir;
        lookup = FS.lookupPath(old_path, {
            parent: true
        });
        old_dir = lookup.node;
        lookup = FS.lookupPath(new_path, {
            parent: true
        });
        new_dir = lookup.node;
        if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
        if (old_dir.mount !== new_dir.mount) {
            throw new FS.ErrnoError(75);
        }
        var old_node = FS.lookupNode(old_dir, old_name);
        var relative = PATH_FS.relative(old_path, new_dirname);
        if (relative.charAt(0) !== ".") {
            throw new FS.ErrnoError(28);
        }
        relative = PATH_FS.relative(new_path, old_dirname);
        if (relative.charAt(0) !== ".") {
            throw new FS.ErrnoError(55);
        }
        var new_node;
        try {
            new_node = FS.lookupNode(new_dir, new_name);
        } catch (e) {}
        if (old_node === new_node) {
            return;
        }
        var isdir = FS.isDir(old_node.mode);
        var errCode = FS.mayDelete(old_dir, old_name, isdir);
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        if (!old_dir.node_ops.rename) {
            throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(old_node) || new_node && FS.isMountpoint(new_node)) {
            throw new FS.ErrnoError(10);
        }
        if (new_dir !== old_dir) {
            errCode = FS.nodePermissions(old_dir, "w");
            if (errCode) {
                throw new FS.ErrnoError(errCode);
            }
        }
        FS.hashRemoveNode(old_node);
        try {
            old_dir.node_ops.rename(old_node, new_dir, new_name);
            if (new_node) {
                FS.hashRemoveNode(new_node);
            }
            old_node.parent = new_dir;
        } catch (e) {
            throw e;
        } finally {
            FS.hashAddNode(old_node);
        }
    },
    rmdir(path) {
        var lookup = FS.lookupPath(path, {
            parent: true
        });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var errCode = FS.mayDelete(parent, name, true);
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.rmdir) {
            throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(10);
        }
        parent.node_ops.rmdir(parent, name);
        FS.destroyNode(node);
    },
    readdir(path) {
        var lookup = FS.lookupPath(path, {
            follow: true
        });
        var node = lookup.node;
        var readdir = FS.checkOpExists(node.node_ops.readdir, 54);
        return readdir(node);
    },
    unlink(path) {
        var lookup = FS.lookupPath(path, {
            parent: true
        });
        var parent = lookup.node;
        if (!parent) {
            throw new FS.ErrnoError(44);
        }
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var errCode = FS.mayDelete(parent, name, false);
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.unlink) {
            throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(10);
        }
        parent.node_ops.unlink(parent, name);
        FS.destroyNode(node);
    },
    readlink(path) {
        var lookup = FS.lookupPath(path);
        var link = lookup.node;
        if (!link) {
            throw new FS.ErrnoError(44);
        }
        if (!link.node_ops.readlink) {
            throw new FS.ErrnoError(28);
        }
        return link.node_ops.readlink(link);
    },
    stat(path, dontFollow = false) {
        var lookup = FS.lookupPath(path, {
            follow: !dontFollow
        });
        var node = lookup.node;
        var getattr = FS.checkOpExists(node.node_ops.getattr, 63);
        return getattr(node);
    },
    fstat(fd) {
        var stream = FS.getStreamChecked(fd);
        var node = stream.node;
        var getattr = stream.stream_ops.getattr;
        var arg = getattr ? stream : node;
        getattr ??= node.node_ops.getattr;
        FS.checkOpExists(getattr, 63);
        return getattr(arg);
    },
    lstat(path) {
        return FS.stat(path, true);
    },
    doChmod(stream, node, mode, dontFollow = false) {
        FS.doSetAttr(stream, node, {
            mode: mode & 4095 | node.mode & ~4095,
            ctime: Date.now(),
            dontFollow: dontFollow
        });
    },
    chmod(path, mode, dontFollow = false) {
        var node;
        if (typeof path === "string") {
            var lookup = FS.lookupPath(path, {
                follow: !dontFollow
            });
            node = lookup.node;
        } else {
            node = path;
        }
        FS.doChmod(null, node, mode, dontFollow);
    },
    lchmod(path, mode) {
        FS.chmod(path, mode, true);
    },
    fchmod(fd, mode) {
        var stream = FS.getStreamChecked(fd);
        FS.doChmod(stream, stream.node, mode, false);
    },
    doChown(stream, node, dontFollow = false) {
        FS.doSetAttr(stream, node, {
            timestamp: Date.now(),
            dontFollow: dontFollow
        });
    },
    chown(path, uid, gid, dontFollow = false) {
        var node;
        if (typeof path === "string") {
            var lookup = FS.lookupPath(path, {
                follow: !dontFollow
            });
            node = lookup.node;
        } else {
            node = path;
        }
        FS.doChown(null, node, dontFollow);
    },
    lchown(path, uid, gid) {
        FS.chown(path, uid, gid, true);
    },
    fchown(fd, uid, gid) {
        var stream = FS.getStreamChecked(fd);
        FS.doChown(stream, stream.node, false);
    },
    doTruncate(stream, node, len) {
        if (FS.isDir(node.mode)) {
            throw new FS.ErrnoError(31);
        }
        if (!FS.isFile(node.mode)) {
            throw new FS.ErrnoError(28);
        }
        var errCode = FS.nodePermissions(node, "w");
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        FS.doSetAttr(stream, node, {
            size: len,
            timestamp: Date.now()
        });
    },
    truncate(path, len) {
        if (len < 0) {
            throw new FS.ErrnoError(28);
        }
        var node;
        if (typeof path === "string") {
            var lookup = FS.lookupPath(path, {
                follow: true
            });
            node = lookup.node;
        } else {
            node = path;
        }
        FS.doTruncate(null, node, len);
    },
    ftruncate(fd, len) {
        var stream = FS.getStreamChecked(fd);
        if (len < 0 || (stream.flags & 2097155) === 0) {
            throw new FS.ErrnoError(28);
        }
        FS.doTruncate(stream, stream.node, len);
    },
    utime(path, atime, mtime, dontFollow = false) {
        var lookup = FS.lookupPath(path, {
            follow: !dontFollow
        });
        FS.doSetAttr(null, lookup.node, {
            atime: atime,
            mtime: mtime,
            dontFollow: dontFollow
        });
    },
    open(path, flags, mode = 438) {
        if (path === "") {
            throw new FS.ErrnoError(44);
        }
        flags = FS_modeStringToFlags(flags);
        if (flags & 64) {
            mode = mode & 4095 | 32768;
        } else {
            mode = 0;
        }
        var node;
        var isDirPath;
        if (typeof path === "object") {
            node = path;
        } else {
            isDirPath = path.endsWith("/");
            var lookup = FS.lookupPath(path, {
                follow: !(flags & 131072),
                noent_okay: true
            });
            node = lookup.node;
            path = lookup.path;
        }
        var created = false;
        if (flags & 64) {
            if (node) {
                if (flags & 128) {
                    throw new FS.ErrnoError(20);
                }
            } else if (isDirPath) {
                throw new FS.ErrnoError(31);
            } else {
                node = FS.mknod(path, mode | 511, 0);
                created = true;
            }
        }
        if (!node) {
            throw new FS.ErrnoError(44);
        }
        if (FS.isChrdev(node.mode)) {
            flags &= ~512;
        }
        if (flags & 65536 && !FS.isDir(node.mode)) {
            throw new FS.ErrnoError(54);
        }
        if (!created) {
            var errCode = FS.mayOpen(node, flags);
            if (errCode) {
                throw new FS.ErrnoError(errCode);
            }
        }
        if (flags & 512 && !created) {
            FS.truncate(node, 0);
        }
        flags &= ~(128 | 512 | 131072);
        var stream = FS.createStream({
            node: node,
            path: FS.getPath(node),
            flags: flags,
            seekable: true,
            position: 0,
            stream_ops: node.stream_ops,
            ungotten: [],
            error: false
        });
        if (stream.stream_ops.open) {
            stream.stream_ops.open(stream);
        }
        if (created) {
            FS.chmod(node, mode & 511);
        }
        return stream;
    },
    close(stream) {
        if (FS.isClosed(stream)) {
            throw new FS.ErrnoError(8);
        }
        if (stream.getdents) stream.getdents = null;
        stream.node?.notifyListeners(32);
        try {
            if (stream.stream_ops.close) {
                stream.stream_ops.close(stream);
            }
        } catch (e) {
            throw e;
        } finally {
            FS.closeStream(stream.fd);
        }
        stream.fd = null;
    },
    isClosed(stream) {
        return stream.fd === null;
    },
    llseek(stream, offset, whence) {
        if (FS.isClosed(stream)) {
            throw new FS.ErrnoError(8);
        }
        if (!stream.seekable || !stream.stream_ops.llseek) {
            throw new FS.ErrnoError(70);
        }
        if (whence != 0 && whence != 1 && whence != 2) {
            throw new FS.ErrnoError(28);
        }
        stream.position = stream.stream_ops.llseek(stream, offset, whence);
        stream.ungotten = [];
        return stream.position;
    },
    read(stream, buffer, offset, length, position = undefined) {
        if (length < 0 || position < 0) {
            throw new FS.ErrnoError(28);
        }
        if (FS.isClosed(stream)) {
            throw new FS.ErrnoError(8);
        }
        if ((stream.flags & 2097155) === 1) {
            throw new FS.ErrnoError(8);
        }
        if (FS.isDir(stream.node.mode)) {
            throw new FS.ErrnoError(31);
        }
        if (!stream.stream_ops.read) {
            throw new FS.ErrnoError(28);
        }
        var seeking = typeof position !== "undefined";
        if (!seeking) {
            position = stream.position;
        } else if (!stream.seekable) {
            throw new FS.ErrnoError(70);
        }
        var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
        if (!seeking) stream.position += bytesRead;
        return bytesRead;
    },
    write(stream, buffer, offset, length, position = undefined, canOwn = undefined) {
        if (length < 0 || position < 0) {
            throw new FS.ErrnoError(28);
        }
        if (FS.isClosed(stream)) {
            throw new FS.ErrnoError(8);
        }
        if ((stream.flags & 2097155) === 0) {
            throw new FS.ErrnoError(8);
        }
        if (FS.isDir(stream.node.mode)) {
            throw new FS.ErrnoError(31);
        }
        if (!stream.stream_ops.write) {
            throw new FS.ErrnoError(28);
        }
        if (stream.seekable && stream.flags & 1024) {
            FS.llseek(stream, 0, 2);
        }
        var seeking = typeof position !== "undefined";
        if (!seeking) {
            position = stream.position;
        } else if (!stream.seekable) {
            throw new FS.ErrnoError(70);
        }
        var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
        if (!seeking) stream.position += bytesWritten;
        return bytesWritten;
    },
    mmap(stream, length, position, prot, flags) {
        if (prot & 2 && !(flags & 2) && (stream.flags & 2097155) !== 2) {
            throw new FS.ErrnoError(2);
        }
        if ((stream.flags & 2097155) === 1) {
            throw new FS.ErrnoError(2);
        }
        if (!stream.stream_ops.mmap) {
            throw new FS.ErrnoError(43);
        }
        if (!length) {
            throw new FS.ErrnoError(28);
        }
        return stream.stream_ops.mmap(stream, length, position, prot, flags);
    },
    msync(stream, buffer, offset, length, mmapFlags) {
        if (!stream.stream_ops.msync) {
            return 0;
        }
        return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
    },
    ioctl(stream, cmd, arg) {
        if (!stream.stream_ops.ioctl) {
            throw new FS.ErrnoError(59);
        }
        return stream.stream_ops.ioctl(stream, cmd, arg);
    },
    readFile(path, opts = {}) {
        opts.flags ??= 0;
        opts.encoding ??= "binary";
        if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
            abort(`Invalid encoding type "${opts.encoding}"`);
        }
        var stream = FS.open(path, opts.flags);
        var stat = FS.stat(path);
        var length = stat.size;
        var buf = new Uint8Array(length);
        FS.read(stream, buf, 0, length, 0);
        if (opts.encoding === "utf8") {
            buf = UTF8ArrayToString(buf);
        }
        FS.close(stream);
        return buf;
    },
    writeFile(path, data, opts = {}) {
        opts.flags ??= 577;
        var stream = FS.open(path, opts.flags, opts.mode);
        data = FS_fileDataToTypedArray(data);
        FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
        FS.close(stream);
    },
    cwd: () => FS.currentPath,
    chdir(path) {
        var lookup = FS.lookupPath(path, {
            follow: true
        });
        if (lookup.node === null) {
            throw new FS.ErrnoError(44);
        }
        if (!FS.isDir(lookup.node.mode)) {
            throw new FS.ErrnoError(54);
        }
        var errCode = FS.nodePermissions(lookup.node, "x");
        if (errCode) {
            throw new FS.ErrnoError(errCode);
        }
        FS.currentPath = lookup.path;
    },
    createDefaultDirectories() {
        FS.mkdir("/tmp");
        FS.mkdir("/home");
        FS.mkdir("/home/web_user");
    },
    createDefaultDevices() {
        FS.mkdir("/dev");
        FS.registerDevice(FS.makedev(1, 3), {
            read: () => 0,
            write: (stream, buffer, offset, length, pos) => length,
            llseek: () => 0
        });
        FS.mkdev("/dev/null", FS.makedev(1, 3));
        TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
        TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
        FS.mkdev("/dev/tty", FS.makedev(5, 0));
        FS.mkdev("/dev/tty1", FS.makedev(6, 0));
        var randomBuffer = new Uint8Array(1024), randomLeft = 0;
        var randomByte = () => {
            if (!randomLeft) {
                randomFill(randomBuffer);
                randomLeft = randomBuffer.byteLength;
            }
            return randomBuffer[--randomLeft];
        };
        FS.createDevice("/dev", "random", randomByte);
        FS.createDevice("/dev", "urandom", randomByte);
        FS.mkdir("/dev/shm");
        FS.mkdir("/dev/shm/tmp");
    },
    createSpecialDirectories() {
        FS.mkdir("/proc");
        var proc_self = FS.mkdir("/proc/self");
        FS.mkdir("/proc/self/fd");
        FS.mount({
            mount() {
                var node = FS.createNode(proc_self, "fd", 16895, 73);
                node.stream_ops = {
                    llseek: MEMFS.stream_ops.llseek
                };
                node.node_ops = {
                    lookup(parent, name) {
                        var fd = +name;
                        var stream = FS.getStreamChecked(fd);
                        var ret = {
                            parent: null,
                            mount: {
                                mountpoint: "fake"
                            },
                            node_ops: {
                                readlink: () => stream.path
                            },
                            id: fd + 1
                        };
                        ret.parent = ret;
                        return ret;
                    },
                    readdir() {
                        return Array.from(FS.streams.entries()).filter(([k, v]) => v).map(([k, v]) => k.toString());
                    }
                };
                return node;
            }
        }, {}, "/proc/self/fd");
    },
    createStandardStreams(input, output, error) {
        if (input) {
            FS.createDevice("/dev", "stdin", input);
        } else {
            FS.symlink("/dev/tty", "/dev/stdin");
        }
        if (output) {
            FS.createDevice("/dev", "stdout", null, output);
        } else {
            FS.symlink("/dev/tty", "/dev/stdout");
        }
        if (error) {
            FS.createDevice("/dev", "stderr", null, error);
        } else {
            FS.symlink("/dev/tty1", "/dev/stderr");
        }
        var stdin = FS.open("/dev/stdin", 0);
        var stdout = FS.open("/dev/stdout", 1);
        var stderr = FS.open("/dev/stderr", 1);
    },
    staticInit() {
        FS.nameTable.length = 4096;
        FS.mount(MEMFS, {}, "/");
        FS.createDefaultDirectories();
        FS.createDefaultDevices();
        FS.createSpecialDirectories();
    },
    init(input = undefined, output = undefined, error = undefined) {
        FS.initialized = true;
        input ??= Module["stdin"];
        output ??= Module["stdout"];
        error ??= Module["stderr"];
        FS.createStandardStreams(input, output, error);
    },
    quit() {
        FS.initialized = false;
        _fflush(0);
        for (var stream of FS.streams) {
            if (stream) {
                FS.close(stream);
            }
        }
    },
    analyzePath(path, dontResolveLastLink = false) {
        try {
            var lookup = FS.lookupPath(path, {
                follow: !dontResolveLastLink
            });
            path = lookup.path;
        } catch (e) {}
        var ret = {
            isRoot: false,
            exists: false,
            error: 0,
            name: null,
            path: null,
            object: null,
            parentExists: false,
            parentPath: null,
            parentObject: null
        };
        try {
            var lookup = FS.lookupPath(path, {
                parent: true
            });
            ret.parentExists = true;
            ret.parentPath = lookup.path;
            ret.parentObject = lookup.node;
            ret.name = PATH.basename(path);
            lookup = FS.lookupPath(path, {
                follow: !dontResolveLastLink
            });
            ret.exists = true;
            ret.path = lookup.path;
            ret.object = lookup.node;
            ret.name = lookup.node.name;
            ret.isRoot = lookup.path === "/";
        } catch (e) {
            ret.error = e.errno;
        }
        return ret;
    },
    createPath(parent, path, canRead = undefined, canWrite = undefined) {
        parent = typeof parent === "string" ? parent : FS.getPath(parent);
        var parts = path.split("/").reverse();
        while (parts.length) {
            var part = parts.pop();
            if (!part) continue;
            var current = PATH.join2(parent, part);
            try {
                FS.mkdir(current);
            } catch (e) {
                if (e.errno != 20) throw e;
            }
            parent = current;
        }
        return current;
    },
    createFile(parent, name, properties, canRead = undefined, canWrite = undefined) {
        var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
        var mode = FS_getMode(canRead, canWrite);
        return FS.create(path, mode);
    },
    createDataFile(parent, name, data = undefined, canRead = undefined, canWrite = undefined, canOwn = undefined) {
        var path = name;
        if (parent) {
            parent = typeof parent === "string" ? parent : FS.getPath(parent);
            path = name ? PATH.join2(parent, name) : parent;
        }
        var mode = FS_getMode(canRead, canWrite);
        var node = FS.create(path, mode);
        if (data) {
            data = FS_fileDataToTypedArray(data);
            FS.chmod(node, mode | 146);
            var stream = FS.open(node, 577);
            FS.write(stream, data, 0, data.length, 0, canOwn);
            FS.close(stream);
            FS.chmod(node, mode);
        }
    },
    createDevice(parent, name, input = undefined, output = undefined) {
        var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
        var mode = FS_getMode(!!input, !!output);
        FS.createDevice.major ??= 64;
        var dev = FS.makedev(FS.createDevice.major++, 0);
        FS.registerDevice(dev, {
            open(stream) {
                stream.seekable = false;
            },
            close(stream) {
                if (output?.buffer?.length) {
                    output(10);
                }
            },
            read(stream, buffer, offset, length, pos) {
                var bytesRead = 0;
                for (var i = 0; i < length; i++) {
                    var result;
                    try {
                        result = input();
                    } catch (e) {
                        throw new FS.ErrnoError(29);
                    }
                    if (result === undefined && !bytesRead) {
                        throw new FS.ErrnoError(6);
                    }
                    if (result === null || result === undefined) break;
                    bytesRead++;
                    buffer[offset + i] = result;
                }
                if (bytesRead) {
                    stream.node.atime = Date.now();
                }
                return bytesRead;
            },
            write(stream, buffer, offset, length, pos) {
                for (var i = 0; i < length; i++) {
                    try {
                        output(buffer[offset + i]);
                    } catch (e) {
                        throw new FS.ErrnoError(29);
                    }
                }
                if (length) {
                    stream.node.mtime = stream.node.ctime = Date.now();
                }
                return i;
            }
        });
        return FS.mkdev(path, mode, dev);
    },
    forceLoadFile(obj) {
        if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
        if (globalThis.XMLHttpRequest) {
            abort("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
        } else {
            try {
                obj.contents = readBinary(obj.url);
            } catch (e) {
                throw new FS.ErrnoError(29);
            }
        }
    },
    createLazyFile(parent, name, url, canRead = undefined, canWrite = undefined) {
        class LazyUint8Array {
            lengthKnown=false;
            chunks=[];
            get(idx) {
                if (idx > this.length - 1 || idx < 0) {
                    return undefined;
                }
                var chunkOffset = idx % this.chunkSize;
                var chunkNum = idx / this.chunkSize | 0;
                return this.getter(chunkNum)[chunkOffset];
            }
            setDataGetter(getter) {
                this.getter = getter;
            }
            cacheLength() {
                var xhr = new XMLHttpRequest;
                xhr.open("HEAD", url, false);
                xhr.send(null);
                if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort(`Couldn't load ${url}. Status: ${xhr.status}`);
                var datalength = Number(xhr.getResponseHeader("Content-length"));
                var header;
                var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
                var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
                var chunkSize = 1024 * 1024;
                if (!hasByteServing) chunkSize = datalength;
                var doXHR = (from, to) => {
                    if (from > to) abort(`invalid range (${from}, ${to}) or no bytes requested!`);
                    if (to > datalength - 1) abort(`only ${datalength} bytes available! programmer error!`);
                    var xhr = new XMLHttpRequest;
                    xhr.open("GET", url, false);
                    if (datalength !== chunkSize) xhr.setRequestHeader("Range", `bytes=${from}-${to}`);
                    xhr.responseType = "arraybuffer";
                    if (xhr.overrideMimeType) {
                        xhr.overrideMimeType("text/plain; charset=x-user-defined");
                    }
                    xhr.send(null);
                    if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort(`Couldn't load ${url}. Status: ${xhr.status}`);
                    if (xhr.response !== undefined) {
                        return new Uint8Array(xhr.response || []);
                    }
                    return intArrayFromString(xhr.responseText ?? "", true);
                };
                var lazyArray = this;
                lazyArray.setDataGetter(chunkNum => {
                    var start = chunkNum * chunkSize;
                    var end = (chunkNum + 1) * chunkSize - 1;
                    end = Math.min(end, datalength - 1);
                    if (typeof lazyArray.chunks[chunkNum] === "undefined") {
                        lazyArray.chunks[chunkNum] = doXHR(start, end);
                    }
                    if (typeof lazyArray.chunks[chunkNum] === "undefined") abort("doXHR failed!");
                    return lazyArray.chunks[chunkNum];
                });
                if (usesGzip || !datalength) {
                    chunkSize = datalength = 1;
                    datalength = this.getter(0).length;
                    chunkSize = datalength;
                    out("LazyFiles on gzip forces download of the whole file when length is accessed");
                }
                this._length = datalength;
                this._chunkSize = chunkSize;
                this.lengthKnown = true;
            }
            get length() {
                if (!this.lengthKnown) {
                    this.cacheLength();
                }
                return this._length;
            }
            get chunkSize() {
                if (!this.lengthKnown) {
                    this.cacheLength();
                }
                return this._chunkSize;
            }
        }
        if (globalThis.XMLHttpRequest) {
            if (!ENVIRONMENT_IS_WORKER) abort("Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc");
            var lazyArray = new LazyUint8Array;
            var properties = {
                isDevice: false,
                contents: lazyArray
            };
        } else {
            var properties = {
                isDevice: false,
                url: url
            };
        }
        var node = FS.createFile(parent, name, properties, canRead, canWrite);
        if (properties.contents) {
            node.contents = properties.contents;
        } else if (properties.url) {
            node.contents = null;
            node.url = properties.url;
        }
        Object.defineProperties(node, {
            usedBytes: {
                get: function() {
                    return this.contents.length;
                }
            }
        });
        var stream_ops = {};
        for (const [key, fn] of Object.entries(node.stream_ops)) {
            stream_ops[key] = (...args) => {
                FS.forceLoadFile(node);
                return fn(...args);
            };
        }
        function writeChunks(stream, buffer, offset, length, position) {
            var contents = stream.node.contents;
            if (position >= contents.length) return 0;
            var size = Math.min(contents.length - position, length);
            if (contents.slice) {
                for (var i = 0; i < size; i++) {
                    buffer[offset + i] = contents[position + i];
                }
            } else {
                for (var i = 0; i < size; i++) {
                    buffer[offset + i] = contents.get(position + i);
                }
            }
            return size;
        }
        stream_ops.read = (stream, buffer, offset, length, position) => {
            FS.forceLoadFile(node);
            return writeChunks(stream, buffer, offset, length, position);
        };
        stream_ops.mmap = (stream, length, position, prot, flags) => {
            FS.forceLoadFile(node);
            var ptr = mmapAlloc(length);
            if (!ptr) {
                throw new FS.ErrnoError(48);
            }
            writeChunks(stream, HEAP8, ptr, length, position);
            return {
                ptr: ptr,
                allocated: true
            };
        };
        node.stream_ops = stream_ops;
        return node;
    }
};

var HEAP16;

var HEAP32;

var HEAP64;

var HEAPU32;

var HEAPU8;

var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => {
    ptr >>>= 0;
    return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul) : "";
};

var SYSCALLS = {
    currentUmask: 18,
    calculateAt(dirfd, path, allowEmpty = false) {
        if (PATH.isAbs(path)) {
            return path;
        }
        var dir;
        if (dirfd === -100) {
            dir = FS.cwd();
        } else {
            var dirstream = SYSCALLS.getStreamFromFD(dirfd);
            dir = dirstream.path;
        }
        if (path.length == 0) {
            if (!allowEmpty) {
                throw new FS.ErrnoError(44);
            }
            return dir;
        }
        return dir + "/" + path;
    },
    writeStat(buf, stat) {
        HEAPU32[buf >>> 2 >>> 0] = stat.dev;
        HEAPU32[buf + 4 >>> 2 >>> 0] = stat.mode;
        HEAPU32[buf + 8 >>> 2 >>> 0] = stat.nlink;
        HEAPU32[buf + 12 >>> 2 >>> 0] = stat.uid;
        HEAPU32[buf + 16 >>> 2 >>> 0] = stat.gid;
        HEAPU32[buf + 20 >>> 2 >>> 0] = stat.rdev;
        HEAP64[buf + 24 >>> 3 >>> 0] = BigInt(stat.size);
        HEAP32[buf + 32 >>> 2 >>> 0] = 4096;
        HEAP32[buf + 36 >>> 2 >>> 0] = stat.blocks;
        var atime = stat.atime.getTime();
        var mtime = stat.mtime.getTime();
        var ctime = stat.ctime.getTime();
        HEAP64[buf + 40 >>> 3 >>> 0] = BigInt(Math.floor(atime / 1e3));
        HEAPU32[buf + 48 >>> 2 >>> 0] = atime % 1e3 * 1e3 * 1e3;
        HEAP64[buf + 56 >>> 3 >>> 0] = BigInt(Math.floor(mtime / 1e3));
        HEAPU32[buf + 64 >>> 2 >>> 0] = mtime % 1e3 * 1e3 * 1e3;
        HEAP64[buf + 72 >>> 3 >>> 0] = BigInt(Math.floor(ctime / 1e3));
        HEAPU32[buf + 80 >>> 2 >>> 0] = ctime % 1e3 * 1e3 * 1e3;
        HEAP64[buf + 88 >>> 3 >>> 0] = BigInt(stat.ino);
        return 0;
    },
    writeStatFs(buf, stats) {
        HEAPU32[buf + 4 >>> 2 >>> 0] = stats.bsize;
        HEAPU32[buf + 60 >>> 2 >>> 0] = stats.bsize;
        HEAP64[buf + 8 >>> 3 >>> 0] = BigInt(stats.blocks);
        HEAP64[buf + 16 >>> 3 >>> 0] = BigInt(stats.bfree);
        HEAP64[buf + 24 >>> 3 >>> 0] = BigInt(stats.bavail);
        HEAP64[buf + 32 >>> 3 >>> 0] = BigInt(stats.files);
        HEAP64[buf + 40 >>> 3 >>> 0] = BigInt(stats.ffree);
        HEAPU32[buf + 48 >>> 2 >>> 0] = stats.fsid;
        HEAPU32[buf + 64 >>> 2 >>> 0] = stats.flags;
        HEAPU32[buf + 56 >>> 2 >>> 0] = stats.namelen;
    },
    doMsync(addr, stream, len, flags, offset) {
        if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(43);
        }
        if (flags & 2) {
            return 0;
        }
        var buffer = HEAPU8.subarray(addr >>> 0, addr + len >>> 0);
        FS.msync(stream, buffer, offset, len, flags);
    },
    getStreamFromFD(fd) {
        var stream = FS.getStreamChecked(fd);
        return stream;
    },
    varargs: undefined,
    getStr(ptr) {
        var ret = UTF8ToString(ptr);
        return ret;
    }
};

var syscallGetVarargI = () => {
    var ret = HEAP32[+SYSCALLS.varargs >>> 2 >>> 0];
    SYSCALLS.varargs += 4;
    return ret;
};

function ___syscall_fcntl64(fd, cmd, varargs) {
    varargs >>>= 0;
    SYSCALLS.varargs = varargs;
    try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        switch (cmd) {
          case 0:
            {
                var arg = syscallGetVarargI();
                if (arg < 0) {
                    return -28;
                }
                while (FS.streams[arg]) {
                    arg++;
                }
                var newStream;
                newStream = FS.dupStream(stream, arg);
                return newStream.fd;
            }

          case 1:
          case 2:
            return 0;

          case 3:
            return stream.flags;

          case 4:
            {
                var arg = syscallGetVarargI();
                var mask = 289792;
                stream.flags = stream.flags & ~mask | arg & mask;
                return 0;
            }

          case 12:
            {
                var arg = syscallGetVarargP();
                var offset = 0;
                HEAP16[arg + offset >>> 1 >>> 0] = 2;
                return 0;
            }

          case 13:
          case 14:
            return 0;
        }
        return -28;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_fstat64(fd, buf) {
    buf >>>= 0;
    try {
        return SYSCALLS.writeStat(buf, FS.fstat(fd));
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

const INT53_MAX = 9007199254740992;

const INT53_MIN = -9007199254740992;

var bigintToI53Checked = num => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);

function ___syscall_ftruncate64(fd, length) {
    length = bigintToI53Checked(length);
    try {
        if (isNaN(length)) return -22;
        FS.ftruncate(fd, length);
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);

function ___syscall_getdents64(fd, dirp, count) {
    dirp >>>= 0;
    count >>>= 0;
    try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        stream.getdents ||= FS.readdir(stream.path);
        var struct_size = 280;
        var pos = 0;
        var off = FS.llseek(stream, 0, 1);
        var startIdx = Math.floor(off / struct_size);
        var endIdx = Math.min(stream.getdents.length, startIdx + Math.floor(count / struct_size));
        for (var idx = startIdx; idx < endIdx; idx++) {
            var id;
            var type;
            var name = stream.getdents[idx];
            if (name === ".") {
                id = stream.node.id;
                type = 4;
            } else if (name === "..") {
                var lookup = FS.lookupPath(stream.path, {
                    parent: true
                });
                id = lookup.node.id;
                type = 4;
            } else {
                var child;
                try {
                    child = FS.lookupNode(stream.node, name);
                } catch (e) {
                    if (e?.errno === 28) {
                        continue;
                    }
                    throw e;
                }
                id = child.id;
                type = FS.isChrdev(child.mode) ? 2 : FS.isDir(child.mode) ? 4 : FS.isLink(child.mode) ? 10 : 8;
            }
            HEAP64[dirp + pos >>> 3 >>> 0] = BigInt(id);
            HEAP64[dirp + pos + 8 >>> 3 >>> 0] = BigInt((idx + 1) * struct_size);
            HEAP16[dirp + pos + 16 >>> 1 >>> 0] = 280;
            HEAP8[dirp + pos + 18 >>> 0] = type;
            stringToUTF8(name, dirp + pos + 19, 256);
            pos += struct_size;
        }
        FS.llseek(stream, idx * struct_size, 0);
        return pos;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_ioctl(fd, op, varargs) {
    varargs >>>= 0;
    SYSCALLS.varargs = varargs;
    try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        switch (op) {
          case 21509:
            {
                if (!stream.tty) return -59;
                return 0;
            }

          case 21505:
            {
                if (!stream.tty) return -59;
                if (stream.tty.ops.ioctl_tcgets) {
                    var termios = stream.tty.ops.ioctl_tcgets(stream);
                    var argp = syscallGetVarargP();
                    HEAP32[argp >>> 2 >>> 0] = termios.c_iflag || 0;
                    HEAP32[argp + 4 >>> 2 >>> 0] = termios.c_oflag || 0;
                    HEAP32[argp + 8 >>> 2 >>> 0] = termios.c_cflag || 0;
                    HEAP32[argp + 12 >>> 2 >>> 0] = termios.c_lflag || 0;
                    for (var i = 0; i < 32; i++) {
                        HEAP8[argp + i + 17 >>> 0] = termios.c_cc[i] || 0;
                    }
                    return 0;
                }
                return 0;
            }

          case 21510:
          case 21511:
          case 21512:
            {
                if (!stream.tty) return -59;
                return 0;
            }

          case 21506:
          case 21507:
          case 21508:
            {
                if (!stream.tty) return -59;
                if (stream.tty.ops.ioctl_tcsets) {
                    var argp = syscallGetVarargP();
                    var c_iflag = HEAP32[argp >>> 2 >>> 0];
                    var c_oflag = HEAP32[argp + 4 >>> 2 >>> 0];
                    var c_cflag = HEAP32[argp + 8 >>> 2 >>> 0];
                    var c_lflag = HEAP32[argp + 12 >>> 2 >>> 0];
                    var c_cc = [];
                    for (var i = 0; i < 32; i++) {
                        c_cc.push(HEAP8[argp + i + 17 >>> 0]);
                    }
                    return stream.tty.ops.ioctl_tcsets(stream.tty, op, {
                        c_iflag: c_iflag,
                        c_oflag: c_oflag,
                        c_cflag: c_cflag,
                        c_lflag: c_lflag,
                        c_cc: c_cc
                    });
                }
                return 0;
            }

          case 21519:
            {
                if (!stream.tty) return -59;
                var argp = syscallGetVarargP();
                HEAP32[argp >>> 2 >>> 0] = 0;
                return 0;
            }

          case 21520:
            {
                if (!stream.tty) return -59;
                return -28;
            }

          case 21537:
          case 21531:
            {
                var argp = syscallGetVarargP();
                return FS.ioctl(stream, op, argp);
            }

          case 21523:
            {
                if (!stream.tty) return -59;
                if (stream.tty.ops.ioctl_tiocgwinsz) {
                    var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
                    var argp = syscallGetVarargP();
                    HEAP16[argp >>> 1 >>> 0] = winsize[0];
                    HEAP16[argp + 2 >>> 1 >>> 0] = winsize[1];
                }
                return 0;
            }

          case 21524:
            {
                if (!stream.tty) return -59;
                return 0;
            }

          case 21515:
            {
                if (!stream.tty) return -59;
                return 0;
            }

          default:
            return -28;
        }
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_lstat64(path, buf) {
    path >>>= 0;
    buf >>>= 0;
    try {
        path = SYSCALLS.getStr(path);
        return SYSCALLS.writeStat(buf, FS.lstat(path));
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_mkdirat(dirfd, path, mode) {
    path >>>= 0;
    try {
        path = SYSCALLS.getStr(path);
        path = SYSCALLS.calculateAt(dirfd, path);
        mode &= ~SYSCALLS.currentUmask;
        FS.mkdir(path, mode);
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_newfstatat(dirfd, path, buf, flags) {
    path >>>= 0;
    buf >>>= 0;
    try {
        path = SYSCALLS.getStr(path);
        var nofollow = flags & 256;
        var allowEmpty = flags & 4096;
        flags = flags & ~6400;
        path = SYSCALLS.calculateAt(dirfd, path, allowEmpty);
        return SYSCALLS.writeStat(buf, nofollow ? FS.lstat(path) : FS.stat(path));
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_openat(dirfd, path, flags, varargs) {
    path >>>= 0;
    varargs >>>= 0;
    SYSCALLS.varargs = varargs;
    try {
        path = SYSCALLS.getStr(path);
        path = SYSCALLS.calculateAt(dirfd, path);
        var mode = varargs ? syscallGetVarargI() : 0;
        if (flags & 64) {
            mode &= ~SYSCALLS.currentUmask;
        }
        return FS.open(path, flags, mode).fd;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_renameat(olddirfd, oldpath, newdirfd, newpath) {
    oldpath >>>= 0;
    newpath >>>= 0;
    try {
        oldpath = SYSCALLS.getStr(oldpath);
        newpath = SYSCALLS.getStr(newpath);
        oldpath = SYSCALLS.calculateAt(olddirfd, oldpath);
        newpath = SYSCALLS.calculateAt(newdirfd, newpath);
        FS.rename(oldpath, newpath);
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_rmdir(path) {
    path >>>= 0;
    try {
        path = SYSCALLS.getStr(path);
        FS.rmdir(path);
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_stat64(path, buf) {
    path >>>= 0;
    buf >>>= 0;
    try {
        path = SYSCALLS.getStr(path);
        return SYSCALLS.writeStat(buf, FS.stat(path));
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function ___syscall_unlinkat(dirfd, path, flags) {
    path >>>= 0;
    try {
        path = SYSCALLS.getStr(path);
        path = SYSCALLS.calculateAt(dirfd, path);
        if (!flags) {
            FS.unlink(path);
        } else if (flags === 512) {
            FS.rmdir(path);
        } else {
            return -28;
        }
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
    }
}

function __gmtime_js(time, tmPtr) {
    time = bigintToI53Checked(time);
    tmPtr >>>= 0;
    var date = new Date(time * 1e3);
    if (isNaN(date.getTime())) {
        return 1;
    }
    HEAP32[tmPtr >>> 2 >>> 0] = date.getUTCSeconds();
    HEAP32[tmPtr + 4 >>> 2 >>> 0] = date.getUTCMinutes();
    HEAP32[tmPtr + 8 >>> 2 >>> 0] = date.getUTCHours();
    HEAP32[tmPtr + 12 >>> 2 >>> 0] = date.getUTCDate();
    HEAP32[tmPtr + 16 >>> 2 >>> 0] = date.getUTCMonth();
    HEAP32[tmPtr + 20 >>> 2 >>> 0] = date.getUTCFullYear() - 1900;
    HEAP32[tmPtr + 24 >>> 2 >>> 0] = date.getUTCDay();
    var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
    var yday = (date.getTime() - start) / (1e3 * 60 * 60 * 24) | 0;
    HEAP32[tmPtr + 28 >>> 2 >>> 0] = yday;
    return 0;
}

var __timegm_js = function(tmPtr) {
    tmPtr >>>= 0;
    var ret = (() => {
        var time = Date.UTC(HEAP32[tmPtr + 20 >>> 2 >>> 0] + 1900, HEAP32[tmPtr + 16 >>> 2 >>> 0], HEAP32[tmPtr + 12 >>> 2 >>> 0], HEAP32[tmPtr + 8 >>> 2 >>> 0], HEAP32[tmPtr + 4 >>> 2 >>> 0], HEAP32[tmPtr >>> 2 >>> 0], 0);
        var date = new Date(time);
        if (isNaN(date.getTime())) {
            return -1;
        }
        HEAP32[tmPtr + 24 >>> 2 >>> 0] = date.getUTCDay();
        var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
        var yday = (date.getTime() - start) / (1e3 * 60 * 60 * 24) | 0;
        HEAP32[tmPtr + 28 >>> 2 >>> 0] = yday;
        return date.getTime() / 1e3;
    })();
    return BigInt(ret);
};

var __tzset_js = function(timezone, daylight, std_name, dst_name) {
    timezone >>>= 0;
    daylight >>>= 0;
    std_name >>>= 0;
    dst_name >>>= 0;
    var currentYear = (new Date).getFullYear();
    var winter = new Date(currentYear, 0, 1);
    var summer = new Date(currentYear, 6, 1);
    var winterOffset = winter.getTimezoneOffset();
    var summerOffset = summer.getTimezoneOffset();
    var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
    HEAPU32[timezone >>> 2 >>> 0] = stdTimezoneOffset * 60;
    HEAP32[daylight >>> 2 >>> 0] = Number(winterOffset != summerOffset);
    var extractZone = timezoneOffset => {
        var sign = timezoneOffset >= 0 ? "-" : "+";
        var absOffset = Math.abs(timezoneOffset);
        var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
        var minutes = String(absOffset % 60).padStart(2, "0");
        return `UTC${sign}${hours}${minutes}`;
    };
    var winterName = extractZone(winterOffset);
    var summerName = extractZone(summerOffset);
    if (summerOffset < winterOffset) {
        stringToUTF8(winterName, std_name, 17);
        stringToUTF8(summerName, dst_name, 17);
    } else {
        stringToUTF8(winterName, dst_name, 17);
        stringToUTF8(summerName, std_name, 17);
    }
};

var checkWasiClock = clock_id => clock_id >= 0 && clock_id <= 3;

const nowIsMonotonic = 1;

var _emscripten_date_now = () => Date.now();

var _emscripten_get_now = () => performance.now();

function _clock_time_get(clk_id, ignored_precision, ptime) {
    ignored_precision = bigintToI53Checked(ignored_precision);
    ptime >>>= 0;
    if (!checkWasiClock(clk_id)) {
        return 28;
    }
    var now;
    if (clk_id === 0) {
        now = _emscripten_date_now();
    } else if (nowIsMonotonic) {
        now = _emscripten_get_now();
    } else {
        return 52;
    }
    var nsec = Math.round(now * 1e6);
    HEAP64[ptime >>> 3 >>> 0] = BigInt(nsec);
    return 0;
}

var maybeCStringToJsString = cString => cString > 2 ? UTF8ToString(cString) : cString;

var specialHTMLTargets = [ 0, globalThis.document ?? 0, globalThis.window ?? 0 ];

var findEventTarget = target => {
    target = maybeCStringToJsString(target);
    var domElement = specialHTMLTargets[target] || globalThis.document?.querySelector(target);
    return domElement;
};

function _emscripten_get_canvas_element_size(target, width, height) {
    target >>>= 0;
    width >>>= 0;
    height >>>= 0;
    var canvas = findCanvasEventTarget(target);
    if (!canvas) return -4;
    HEAP32[width >>> 2 >>> 0] = canvas.width;
    HEAP32[height >>> 2 >>> 0] = canvas.height;
    return 0;
}

var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;

var getHeapMax = () => 4294901760;

var growMemory = size => {
    var oldHeapSize = wasmMemory.buffer.byteLength;
    var pages = (size - oldHeapSize + 65535) / 65536 | 0;
    try {
        wasmMemory.grow(pages);
        updateMemoryViews();
        return 1;
    } catch (e) {}
};

function _emscripten_resize_heap(requestedSize) {
    requestedSize >>>= 0;
    var oldSize = HEAPU8.length;
    var maxHeapSize = getHeapMax();
    if (requestedSize > maxHeapSize) {
        return false;
    }
    for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
        var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
        overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
        var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
        var replacement = growMemory(newSize);
        if (replacement) {
            return true;
        }
    }
    return false;
}

var GLctx;

var getEmscriptenSupportedExtensions = ctx => {
    var supportedExtensions = [ "EXT_color_buffer_float", "EXT_conservative_depth", "EXT_disjoint_timer_query_webgl2", "EXT_texture_norm16", "NV_shader_noperspective_interpolation", "WEBGL_clip_cull_distance", "EXT_clip_control", "EXT_color_buffer_half_float", "EXT_depth_clamp", "EXT_float_blend", "EXT_polygon_offset_clamp", "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic", "KHR_parallel_shader_compile", "OES_texture_float_linear", "WEBGL_blend_func_extended", "WEBGL_compressed_texture_astc", "WEBGL_compressed_texture_etc", "WEBGL_compressed_texture_etc1", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_debug_renderer_info", "WEBGL_debug_shaders", "WEBGL_lose_context", "WEBGL_multi_draw", "WEBGL_polygon_mode" ];
    return ctx.getSupportedExtensions()?.filter(ext => supportedExtensions.includes(ext)) ?? [];
};

var webgl_enable_EXT_clip_control = ctx => !!(ctx.extClipControl = ctx.getExtension("EXT_clip_control"));

var webgl_enable_EXT_polygon_offset_clamp = ctx => !!(ctx.extPolygonOffsetClamp = ctx.getExtension("EXT_polygon_offset_clamp"));

var webgl_enable_WEBGL_draw_instanced_base_vertex_base_instance = ctx => !!(ctx.dibvbi = ctx.getExtension("WEBGL_draw_instanced_base_vertex_base_instance"));

var webgl_enable_WEBGL_multi_draw = ctx => !!(ctx.multiDrawWebgl = ctx.getExtension("WEBGL_multi_draw"));

var webgl_enable_WEBGL_multi_draw_instanced_base_vertex_base_instance = ctx => !!(ctx.mdibvbi = ctx.getExtension("WEBGL_multi_draw_instanced_base_vertex_base_instance"));

var webgl_enable_WEBGL_polygon_mode = ctx => !!(ctx.webglPolygonMode = ctx.getExtension("WEBGL_polygon_mode"));

var GL = {
    counter: 1,
    buffers: [],
    programs: [],
    framebuffers: [],
    renderbuffers: [],
    textures: [],
    shaders: [],
    vaos: [],
    contexts: [],
    offscreenCanvases: {},
    queries: [],
    samplers: [],
    transformFeedbacks: [],
    syncs: [],
    stringCache: {},
    stringiCache: {},
    unpackAlignment: 4,
    unpackRowLength: 0,
    recordError: errorCode => {
        if (!GL.lastError) {
            GL.lastError = errorCode;
        }
    },
    getNewId: table => {
        var ret = GL.counter++;
        for (var i = table.length; i < ret; i++) {
            table[i] = null;
        }
        return ret;
    },
    genObject: (n, buffers, createFunction, objectTable) => {
        for (var i = 0; i < n; i++) {
            var buffer = GLctx[createFunction]();
            var id = buffer && GL.getNewId(objectTable);
            if (buffer) {
                buffer.name = id;
                objectTable[id] = buffer;
            } else {
                GL.recordError(1282);
            }
            HEAP32[buffers + i * 4 >>> 2 >>> 0] = id;
        }
    },
    getSource: (shader, count, string, length) => {
        var source = "";
        for (var i = 0; i < count; ++i) {
            var len = length ? HEAPU32[length + i * 4 >>> 2 >>> 0] : undefined;
            source += UTF8ToString(HEAPU32[string + i * 4 >>> 2 >>> 0], len);
        }
        return source;
    },
    createContext: (canvas, webGLContextAttributes) => {
        if (!canvas.getContextSafariWebGL2Fixed) {
            canvas.getContextSafariWebGL2Fixed = canvas.getContext;
            function fixedGetContext(ver, attrs) {
                var gl = canvas.getContextSafariWebGL2Fixed(ver, attrs);
                return ver == "webgl" == gl instanceof WebGLRenderingContext ? gl : null;
            }
            canvas.getContext = fixedGetContext;
        }
        var ctx = canvas.getContext("webgl2", webGLContextAttributes);
        if (!ctx) return 0;
        var handle = GL.registerContext(ctx, webGLContextAttributes);
        return handle;
    },
    registerContext: (ctx, webGLContextAttributes) => {
        var handle = GL.getNewId(GL.contexts);
        var context = {
            handle: handle,
            attributes: webGLContextAttributes,
            version: webGLContextAttributes.majorVersion,
            GLctx: ctx
        };
        if (ctx.canvas) ctx.canvas.GLctxObject = context;
        GL.contexts[handle] = context;
        if (typeof webGLContextAttributes.enableExtensionsByDefault === "undefined" || webGLContextAttributes.enableExtensionsByDefault) {
            GL.initExtensions(context);
        }
        return handle;
    },
    makeContextCurrent: contextHandle => {
        GL.currentContext = GL.contexts[contextHandle];
        Module["ctx"] = GLctx = GL.currentContext?.GLctx;
        return !(contextHandle && !GLctx);
    },
    getContext: contextHandle => GL.contexts[contextHandle],
    deleteContext: contextHandle => {
        if (GL.currentContext === GL.contexts[contextHandle]) {
            GL.currentContext = null;
        }
        if (typeof JSEvents === "object") {
            JSEvents.removeAllHandlersOnTarget(GL.contexts[contextHandle].GLctx.canvas);
        }
        if (GL.contexts[contextHandle]?.GLctx.canvas) {
            GL.contexts[contextHandle].GLctx.canvas.GLctxObject = undefined;
        }
        GL.contexts[contextHandle] = null;
    },
    initExtensions: context => {
        context ||= GL.currentContext;
        if (context.initExtensionsDone) return;
        context.initExtensionsDone = true;
        var gl = context.GLctx;
        webgl_enable_WEBGL_multi_draw(gl);
        webgl_enable_EXT_polygon_offset_clamp(gl);
        webgl_enable_EXT_clip_control(gl);
        webgl_enable_WEBGL_polygon_mode(gl);
        webgl_enable_WEBGL_draw_instanced_base_vertex_base_instance(gl);
        webgl_enable_WEBGL_multi_draw_instanced_base_vertex_base_instance(gl);
        if (context.version >= 2) {
            gl.disjointTimerQueryExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
        }
        if (context.version < 2 || !gl.disjointTimerQueryExt) {
            gl.disjointTimerQueryExt = gl.getExtension("EXT_disjoint_timer_query");
        }
        for (var ext of getEmscriptenSupportedExtensions(gl)) {
            if (!ext.includes("lose_context") && !ext.includes("debug")) {
                gl.getExtension(ext);
            }
        }
    }
};

var webglPowerPreferences = [ "default", "low-power", "high-performance" ];

function __emscripten_webgl_do_create_context(target, attributes) {
    target >>>= 0;
    attributes >>>= 0;
    var attr32 = attributes >>> 2;
    var powerPreference = HEAP32[attr32 + (8 >> 2) >>> 0];
    var contextAttributes = {
        alpha: !!HEAP8[attributes + 0 >>> 0],
        depth: !!HEAP8[attributes + 1 >>> 0],
        stencil: !!HEAP8[attributes + 2 >>> 0],
        antialias: !!HEAP8[attributes + 3 >>> 0],
        premultipliedAlpha: !!HEAP8[attributes + 4 >>> 0],
        preserveDrawingBuffer: !!HEAP8[attributes + 5 >>> 0],
        powerPreference: webglPowerPreferences[powerPreference],
        failIfMajorPerformanceCaveat: !!HEAP8[attributes + 12 >>> 0],
        desynchronized: !!HEAP8[attributes + 33 >>> 0],
        majorVersion: HEAP32[attr32 + (16 >> 2) >>> 0],
        minorVersion: HEAP32[attr32 + (20 >> 2) >>> 0],
        enableExtensionsByDefault: HEAP8[attributes + 24 >>> 0],
        explicitSwapControl: HEAP8[attributes + 25 >>> 0],
        proxyContextToMainThread: HEAP32[attr32 + (28 >> 2) >>> 0],
        renderViaOffscreenBackBuffer: HEAP8[attributes + 32 >>> 0]
    };
    var canvas = findCanvasEventTarget(target);
    if (!canvas) {
        return 0;
    }
    if (contextAttributes.explicitSwapControl) {
        return 0;
    }
    var contextHandle = GL.createContext(canvas, contextAttributes);
    return contextHandle;
}

function _emscripten_webgl_enable_extension(contextHandle, extension) {
    contextHandle >>>= 0;
    extension >>>= 0;
    var context = GL.getContext(contextHandle);
    var extString = UTF8ToString(extension);
    if (extString.startsWith("GL_")) extString = extString.slice(3);
    if (extString == "WEBGL_draw_instanced_base_vertex_base_instance") webgl_enable_WEBGL_draw_instanced_base_vertex_base_instance(GLctx);
    if (extString == "WEBGL_multi_draw_instanced_base_vertex_base_instance") webgl_enable_WEBGL_multi_draw_instanced_base_vertex_base_instance(GLctx);
    if (extString == "WEBGL_multi_draw") webgl_enable_WEBGL_multi_draw(GLctx);
    if (extString == "EXT_polygon_offset_clamp") webgl_enable_EXT_polygon_offset_clamp(GLctx);
    if (extString == "EXT_clip_control") webgl_enable_EXT_clip_control(GLctx);
    if (extString == "WEBGL_polygon_mode") webgl_enable_WEBGL_polygon_mode(GLctx);
    var ext = context.GLctx.getExtension(extString);
    return !!ext;
}

function _emscripten_webgl_make_context_current(contextHandle) {
    contextHandle >>>= 0;
    var success = GL.makeContextCurrent(contextHandle);
    return success ? 0 : -5;
}

var ENV = {};

var getExecutableName = () => thisProgram;

var getEnvStrings = () => {
    if (!getEnvStrings.strings) {
        var lang = (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8";
        var env = {
            USER: "web_user",
            LOGNAME: "web_user",
            PATH: "/",
            PWD: "/",
            HOME: "/home/web_user",
            LANG: lang,
            _: getExecutableName()
        };
        for (var x in ENV) {
            if (ENV[x] === undefined) delete env[x]; else env[x] = ENV[x];
        }
        var strings = [];
        for (var x in env) {
            strings.push(`${x}=${env[x]}`);
        }
        getEnvStrings.strings = strings;
    }
    return getEnvStrings.strings;
};

function _environ_get(__environ, environ_buf) {
    __environ >>>= 0;
    environ_buf >>>= 0;
    var bufSize = 0;
    var envp = 0;
    for (var string of getEnvStrings()) {
        var ptr = environ_buf + bufSize;
        HEAPU32[__environ + envp >>> 2 >>> 0] = ptr;
        bufSize += stringToUTF8(string, ptr, Infinity) + 1;
        envp += 4;
    }
    return 0;
}

function _environ_sizes_get(penviron_count, penviron_buf_size) {
    penviron_count >>>= 0;
    penviron_buf_size >>>= 0;
    var strings = getEnvStrings();
    HEAPU32[penviron_count >>> 2 >>> 0] = strings.length;
    var bufSize = 0;
    for (var string of strings) {
        bufSize += lengthBytesUTF8(string) + 1;
    }
    HEAPU32[penviron_buf_size >>> 2 >>> 0] = bufSize;
    return 0;
}

var runtimeKeepaliveCounter = 0;

var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;

var _proc_exit = code => {
    EXITSTATUS = code;
    if (!keepRuntimeAlive()) {
        Module["onExit"]?.(code);
        ABORT = true;
    }
    quit_(code, new ExitStatus(code));
};

var exitJS = (status, implicit) => {
    EXITSTATUS = status;
    if (!keepRuntimeAlive()) {
        exitRuntime();
    }
    _proc_exit(status);
};

function _fd_close(fd) {
    try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        FS.close(stream);
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
    }
}

var doReadv = (stream, iov, iovcnt, offset) => {
    var ret = 0;
    for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[iov >>> 2 >>> 0];
        var len = HEAPU32[iov + 4 >>> 2 >>> 0];
        iov += 8;
        try {
            var curr = FS.read(stream, HEAP8, ptr, len, offset);
        } catch (e) {
            if (ret > 0 && e instanceof FS.ErrnoError && (e.errno == 6 || e.errno == 6)) {
                break;
            }
            throw e;
        }
        if (curr < 0) return -1;
        ret += curr;
        if (curr < len) break;
        if (typeof offset !== "undefined") {
            offset += curr;
        }
    }
    return ret;
};

function _fd_read(fd, iov, iovcnt, pnum) {
    iov >>>= 0;
    iovcnt >>>= 0;
    pnum >>>= 0;
    try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        var num = doReadv(stream, iov, iovcnt);
        HEAPU32[pnum >>> 2 >>> 0] = num;
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
    }
}

function _fd_seek(fd, offset, whence, newOffset) {
    offset = bigintToI53Checked(offset);
    newOffset >>>= 0;
    try {
        if (isNaN(offset)) return 22;
        var stream = SYSCALLS.getStreamFromFD(fd);
        FS.llseek(stream, offset, whence);
        HEAP64[newOffset >>> 3 >>> 0] = BigInt(stream.position);
        if (stream.getdents && !offset && whence === 0) stream.getdents = null;
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
    }
}

var doWritev = (stream, iov, iovcnt, offset) => {
    if (iovcnt == 1) {
        return FS.write(stream, HEAP8, HEAPU32[iov >>> 2 >>> 0], HEAPU32[iov + 4 >>> 2 >>> 0], offset);
    }
    var total = 0;
    for (var i = 0, p = iov; i < iovcnt; i++, p += 8) {
        total += HEAPU32[p + 4 >>> 2 >>> 0];
    }
    var view = new Uint8Array(total);
    var voff = 0;
    for (var i = 0; i < iovcnt; i++, iov += 8) {
        var ptr = HEAPU32[iov >>> 2 >>> 0];
        var len = HEAPU32[iov + 4 >>> 2 >>> 0];
        view.set(HEAPU8.subarray(ptr >>> 0, ptr + len >>> 0), voff);
        voff += len;
    }
    return FS.write(stream, view, 0, total, offset);
};

function _fd_write(fd, iov, iovcnt, pnum) {
    iov >>>= 0;
    iovcnt >>>= 0;
    pnum >>>= 0;
    try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        var num = doWritev(stream, iov, iovcnt);
        HEAPU32[pnum >>> 2 >>> 0] = num;
        return 0;
    } catch (e) {
        if (typeof FS === "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
    }
}

var _emscripten_glActiveTexture = x0 => GLctx.activeTexture(x0);

var _emscripten_glAttachShader = (program, shader) => {
    GLctx.attachShader(GL.programs[program], GL.shaders[shader]);
};

var _emscripten_glBindBuffer = (target, buffer) => {
    if (target == 35051) {
        GLctx.currentPixelPackBufferBinding = buffer;
    } else if (target == 35052) {
        GLctx.currentPixelUnpackBufferBinding = buffer;
    }
    GLctx.bindBuffer(target, GL.buffers[buffer]);
};

function _emscripten_glBindBufferRange(target, index, buffer, offset, ptrsize) {
    offset >>>= 0;
    ptrsize >>>= 0;
    GLctx.bindBufferRange(target, index, GL.buffers[buffer], offset, ptrsize);
}

var _emscripten_glBindFramebuffer = (target, framebuffer) => {
    GLctx.bindFramebuffer(target, GL.framebuffers[framebuffer]);
};

var _emscripten_glBindSampler = (unit, sampler) => {
    GLctx.bindSampler(unit, GL.samplers[sampler]);
};

var _emscripten_glBindTexture = (target, texture) => {
    GLctx.bindTexture(target, GL.textures[texture]);
};

var _emscripten_glBindVertexArray = vao => {
    GLctx.bindVertexArray(GL.vaos[vao]);
};

var _emscripten_glBlendColor = (x0, x1, x2, x3) => GLctx.blendColor(x0, x1, x2, x3);

var _emscripten_glBlendEquationSeparate = (x0, x1) => GLctx.blendEquationSeparate(x0, x1);

var _emscripten_glBlendFuncSeparate = (x0, x1, x2, x3) => GLctx.blendFuncSeparate(x0, x1, x2, x3);

var _emscripten_glBlitFramebuffer = (x0, x1, x2, x3, x4, x5, x6, x7, x8, x9) => GLctx.blitFramebuffer(x0, x1, x2, x3, x4, x5, x6, x7, x8, x9);

function _emscripten_glBufferData(target, size, data, usage) {
    size >>>= 0;
    data >>>= 0;
    GLctx.bufferData(target, data ? HEAPU8.subarray(data >>> 0, data + size >>> 0) : size, usage);
}

var webglBufferSubData = (target, offset, size, data, src = HEAPU8) => {
    GLctx.bufferSubData(target, offset, src.subarray(data, data + size));
};

function _emscripten_glBufferSubData(target, offset, size, data) {
    offset >>>= 0;
    size >>>= 0;
    data >>>= 0;
    return webglBufferSubData(target, offset, size, data);
}

var _emscripten_glClearBufferfi = (x0, x1, x2, x3) => GLctx.clearBufferfi(x0, x1, x2, x3);

var HEAPF32;

function _emscripten_glClearBufferfv(buffer, drawbuffer, value) {
    value >>>= 0;
    GLctx.clearBufferfv(buffer, drawbuffer, HEAPF32, value >>> 2);
}

function _emscripten_glClearBufferiv(buffer, drawbuffer, value) {
    value >>>= 0;
    GLctx.clearBufferiv(buffer, drawbuffer, HEAP32, value >>> 2);
}

function _emscripten_glClearBufferuiv(buffer, drawbuffer, value) {
    value >>>= 0;
    GLctx.clearBufferuiv(buffer, drawbuffer, HEAPU32, value >>> 2);
}

var _emscripten_glColorMask = (red, green, blue, alpha) => {
    GLctx.colorMask(!!red, !!green, !!blue, !!alpha);
};

var _emscripten_glCompileShader = shader => {
    GLctx.compileShader(GL.shaders[shader]);
};

function _emscripten_glCompressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, imageSize, data) {
    data >>>= 0;
    if (true) {
        if (GLctx.currentPixelUnpackBufferBinding || !imageSize) {
            GLctx.compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, imageSize, data);
            return;
        }
    }
    GLctx.compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, HEAPU8.subarray(data >>> 0, data + imageSize >>> 0));
}

function _emscripten_glCompressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, data) {
    data >>>= 0;
    if (GLctx.currentPixelUnpackBufferBinding) {
        GLctx.compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, data);
    } else {
        GLctx.compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, HEAPU8, data, imageSize);
    }
}

function _emscripten_glCopyBufferSubData(x0, x1, x2, x3, x4) {
    x2 >>>= 0;
    x3 >>>= 0;
    x4 >>>= 0;
    return GLctx.copyBufferSubData(x0, x1, x2, x3, x4);
}

var _emscripten_glCopyTexSubImage2D = (x0, x1, x2, x3, x4, x5, x6, x7) => GLctx.copyTexSubImage2D(x0, x1, x2, x3, x4, x5, x6, x7);

var _emscripten_glCopyTexSubImage3D = (x0, x1, x2, x3, x4, x5, x6, x7, x8) => GLctx.copyTexSubImage3D(x0, x1, x2, x3, x4, x5, x6, x7, x8);

var _emscripten_glCreateProgram = () => {
    var id = GL.getNewId(GL.programs);
    var program = GLctx.createProgram();
    program.name = id;
    program.maxUniformLength = program.maxAttributeLength = program.maxUniformBlockNameLength = 0;
    program.uniformIdCounter = 1;
    GL.programs[id] = program;
    return id;
};

var _emscripten_glCreateShader = shaderType => {
    var id = GL.getNewId(GL.shaders);
    GL.shaders[id] = GLctx.createShader(shaderType);
    return id;
};

var _emscripten_glCullFace = x0 => GLctx.cullFace(x0);

function _emscripten_glDeleteFramebuffers(n, framebuffers) {
    framebuffers >>>= 0;
    for (var i = 0; i < n; ++i) {
        var id = HEAP32[framebuffers + i * 4 >>> 2 >>> 0];
        var framebuffer = GL.framebuffers[id];
        if (!framebuffer) continue;
        GLctx.deleteFramebuffer(framebuffer);
        framebuffer.name = 0;
        GL.framebuffers[id] = null;
    }
}

var _emscripten_glDeleteProgram = id => {
    if (!id) return;
    var program = GL.programs[id];
    if (!program) {
        GL.recordError(1281);
        return;
    }
    GLctx.deleteProgram(program);
    program.name = 0;
    GL.programs[id] = null;
};

var _emscripten_glDeleteShader = id => {
    if (!id) return;
    var shader = GL.shaders[id];
    if (!shader) {
        GL.recordError(1281);
        return;
    }
    GLctx.deleteShader(shader);
    GL.shaders[id] = null;
};

var _emscripten_glDepthFunc = x0 => GLctx.depthFunc(x0);

var _emscripten_glDepthMask = flag => {
    GLctx.depthMask(!!flag);
};

var _emscripten_glDepthRangef = (x0, x1) => GLctx.depthRange(x0, x1);

var _emscripten_glDisable = x0 => GLctx.disable(x0);

var _emscripten_glDisableVertexAttribArray = index => {
    GLctx.disableVertexAttribArray(index);
};

var _emscripten_glDrawArrays = (mode, first, count) => {
    GLctx.drawArrays(mode, first, count);
};

var _emscripten_glDrawArraysInstanced = (mode, first, count, primcount) => {
    GLctx.drawArraysInstanced(mode, first, count, primcount);
};

var tempFixedLengthArray = [];

function _emscripten_glDrawBuffers(n, bufs) {
    bufs >>>= 0;
    var bufArray = tempFixedLengthArray[n];
    for (var i = 0; i < n; i++) {
        bufArray[i] = HEAP32[bufs + i * 4 >>> 2 >>> 0];
    }
    GLctx.drawBuffers(bufArray);
}

function _emscripten_glDrawElements(mode, count, type, indices) {
    indices >>>= 0;
    GLctx.drawElements(mode, count, type, indices);
}

function _emscripten_glDrawElementsInstanced(mode, count, type, indices, primcount) {
    indices >>>= 0;
    GLctx.drawElementsInstanced(mode, count, type, indices, primcount);
}

var _emscripten_glEnable = x0 => GLctx.enable(x0);

var _emscripten_glEnableVertexAttribArray = index => {
    GLctx.enableVertexAttribArray(index);
};

var _emscripten_glFramebufferTexture2D = (target, attachment, textarget, texture, level) => {
    GLctx.framebufferTexture2D(target, attachment, textarget, GL.textures[texture], level);
};

var _emscripten_glFramebufferTextureLayer = (target, attachment, texture, level, layer) => {
    GLctx.framebufferTextureLayer(target, attachment, GL.textures[texture], level, layer);
};

var _emscripten_glFrontFace = x0 => GLctx.frontFace(x0);

function _emscripten_glGenBuffers(n, buffers) {
    buffers >>>= 0;
    GL.genObject(n, buffers, "createBuffer", GL.buffers);
}

function _emscripten_glGenFramebuffers(n, ids) {
    ids >>>= 0;
    GL.genObject(n, ids, "createFramebuffer", GL.framebuffers);
}

function _emscripten_glGenSamplers(n, samplers) {
    samplers >>>= 0;
    GL.genObject(n, samplers, "createSampler", GL.samplers);
}

function _emscripten_glGenTextures(n, textures) {
    textures >>>= 0;
    GL.genObject(n, textures, "createTexture", GL.textures);
}

function _emscripten_glGenVertexArrays(n, arrays) {
    arrays >>>= 0;
    GL.genObject(n, arrays, "createVertexArray", GL.vaos);
}

function _emscripten_glGetProgramInfoLog(program, maxLength, length, infoLog) {
    length >>>= 0;
    infoLog >>>= 0;
    var log = GLctx.getProgramInfoLog(GL.programs[program]);
    if (log === null) log = "(unknown error)";
    var numBytesWrittenExclNull = maxLength > 0 && infoLog ? stringToUTF8(log, infoLog, maxLength) : 0;
    if (length) HEAP32[length >>> 2 >>> 0] = numBytesWrittenExclNull;
}

function _emscripten_glGetProgramiv(program, pname, p) {
    p >>>= 0;
    if (!p) {
        GL.recordError(1281);
        return;
    }
    if (program >= GL.counter) {
        GL.recordError(1281);
        return;
    }
    program = GL.programs[program];
    if (pname == 35716) {
        var log = GLctx.getProgramInfoLog(program);
        if (log === null) log = "(unknown error)";
        HEAP32[p >>> 2 >>> 0] = log.length + 1;
    } else if (pname == 35719) {
        if (!program.maxUniformLength) {
            var numActiveUniforms = GLctx.getProgramParameter(program, 35718);
            for (var i = 0; i < numActiveUniforms; ++i) {
                program.maxUniformLength = Math.max(program.maxUniformLength, GLctx.getActiveUniform(program, i).name.length + 1);
            }
        }
        HEAP32[p >>> 2 >>> 0] = program.maxUniformLength;
    } else if (pname == 35722) {
        if (!program.maxAttributeLength) {
            var numActiveAttributes = GLctx.getProgramParameter(program, 35721);
            for (var i = 0; i < numActiveAttributes; ++i) {
                program.maxAttributeLength = Math.max(program.maxAttributeLength, GLctx.getActiveAttrib(program, i).name.length + 1);
            }
        }
        HEAP32[p >>> 2 >>> 0] = program.maxAttributeLength;
    } else if (pname == 35381) {
        if (!program.maxUniformBlockNameLength) {
            var numActiveUniformBlocks = GLctx.getProgramParameter(program, 35382);
            for (var i = 0; i < numActiveUniformBlocks; ++i) {
                program.maxUniformBlockNameLength = Math.max(program.maxUniformBlockNameLength, GLctx.getActiveUniformBlockName(program, i).length + 1);
            }
        }
        HEAP32[p >>> 2 >>> 0] = program.maxUniformBlockNameLength;
    } else {
        HEAP32[p >>> 2 >>> 0] = GLctx.getProgramParameter(program, pname);
    }
}

function _emscripten_glGetShaderInfoLog(shader, maxLength, length, infoLog) {
    length >>>= 0;
    infoLog >>>= 0;
    var log = GLctx.getShaderInfoLog(GL.shaders[shader]);
    if (log === null) log = "(unknown error)";
    var numBytesWrittenExclNull = maxLength > 0 && infoLog ? stringToUTF8(log, infoLog, maxLength) : 0;
    if (length) HEAP32[length >>> 2 >>> 0] = numBytesWrittenExclNull;
}

function _emscripten_glGetShaderiv(shader, pname, p) {
    p >>>= 0;
    if (!p) {
        GL.recordError(1281);
        return;
    }
    if (pname == 35716) {
        var log = GLctx.getShaderInfoLog(GL.shaders[shader]);
        if (log === null) log = "(unknown error)";
        var logLength = log ? log.length + 1 : 0;
        HEAP32[p >>> 2 >>> 0] = logLength;
    } else if (pname == 35720) {
        var source = GLctx.getShaderSource(GL.shaders[shader]);
        var sourceLength = source ? source.length + 1 : 0;
        HEAP32[p >>> 2 >>> 0] = sourceLength;
    } else {
        HEAP32[p >>> 2 >>> 0] = GLctx.getShaderParameter(GL.shaders[shader], pname);
    }
}

function _emscripten_glGetUniformBlockIndex(program, uniformBlockName) {
    uniformBlockName >>>= 0;
    return GLctx.getUniformBlockIndex(GL.programs[program], UTF8ToString(uniformBlockName));
}

var jstoi_q = str => parseInt(str);

var webglGetLeftBracePos = name => name.slice(-1) == "]" && name.lastIndexOf("[");

var webglPrepareUniformLocationsBeforeFirstUse = program => {
    var uniformLocsById = program.uniformLocsById, uniformSizeAndIdsByName = program.uniformSizeAndIdsByName, i, j;
    if (!uniformLocsById) {
        program.uniformLocsById = uniformLocsById = {};
        program.uniformArrayNamesById = {};
        var numActiveUniforms = GLctx.getProgramParameter(program, 35718);
        for (i = 0; i < numActiveUniforms; ++i) {
            var u = GLctx.getActiveUniform(program, i);
            var nm = u.name;
            var sz = u.size;
            var lb = webglGetLeftBracePos(nm);
            var arrayName = lb > 0 ? nm.slice(0, lb) : nm;
            var id = program.uniformIdCounter;
            program.uniformIdCounter += sz;
            uniformSizeAndIdsByName[arrayName] = [ sz, id ];
            for (j = 0; j < sz; ++j) {
                uniformLocsById[id] = j;
                program.uniformArrayNamesById[id++] = arrayName;
            }
        }
    }
};

function _emscripten_glGetUniformLocation(program, name) {
    name >>>= 0;
    name = UTF8ToString(name);
    if (program = GL.programs[program]) {
        webglPrepareUniformLocationsBeforeFirstUse(program);
        var uniformLocsById = program.uniformLocsById;
        var arrayIndex = 0;
        var uniformBaseName = name;
        var leftBrace = webglGetLeftBracePos(name);
        if (leftBrace > 0) {
            arrayIndex = jstoi_q(name.slice(leftBrace + 1)) >>> 0;
            uniformBaseName = name.slice(0, leftBrace);
        }
        var sizeAndId = program.uniformSizeAndIdsByName[uniformBaseName];
        if (sizeAndId && arrayIndex < sizeAndId[0]) {
            arrayIndex += sizeAndId[1];
            if (uniformLocsById[arrayIndex] = uniformLocsById[arrayIndex] || GLctx.getUniformLocation(program, name)) {
                return arrayIndex;
            }
        }
    } else {
        GL.recordError(1281);
    }
    return -1;
}

var _emscripten_glLinkProgram = program => {
    program = GL.programs[program];
    GLctx.linkProgram(program);
    program.uniformLocsById = 0;
    program.uniformSizeAndIdsByName = {};
};

var _emscripten_glPixelStorei = (pname, param) => {
    if (pname == 3317) {
        GL.unpackAlignment = param;
    } else if (pname == 3314) {
        GL.unpackRowLength = param;
    }
    GLctx.pixelStorei(pname, param);
};

var _emscripten_glPolygonOffset = (x0, x1) => GLctx.polygonOffset(x0, x1);

var _emscripten_glSamplerParameterf = (sampler, pname, param) => {
    GLctx.samplerParameterf(GL.samplers[sampler], pname, param);
};

var _emscripten_glSamplerParameteri = (sampler, pname, param) => {
    GLctx.samplerParameteri(GL.samplers[sampler], pname, param);
};

var _emscripten_glScissor = (x0, x1, x2, x3) => GLctx.scissor(x0, x1, x2, x3);

function _emscripten_glShaderSource(shader, count, string, length) {
    string >>>= 0;
    length >>>= 0;
    var source = GL.getSource(shader, count, string, length);
    GLctx.shaderSource(GL.shaders[shader], source);
}

var _emscripten_glStencilFuncSeparate = (x0, x1, x2, x3) => GLctx.stencilFuncSeparate(x0, x1, x2, x3);

var _emscripten_glStencilMask = x0 => GLctx.stencilMask(x0);

var _emscripten_glStencilOpSeparate = (x0, x1, x2, x3) => GLctx.stencilOpSeparate(x0, x1, x2, x3);

var _emscripten_glTexParameteri = (x0, x1, x2) => GLctx.texParameteri(x0, x1, x2);

var _emscripten_glTexStorage2D = (x0, x1, x2, x3, x4) => GLctx.texStorage2D(x0, x1, x2, x3, x4);

var _emscripten_glTexStorage3D = (x0, x1, x2, x3, x4, x5) => GLctx.texStorage3D(x0, x1, x2, x3, x4, x5);

var colorChannelsInGlTextureFormat = format => {
    var colorChannels = {
        5: 3,
        6: 4,
        8: 2,
        29502: 3,
        29504: 4,
        26917: 2,
        26918: 2,
        29846: 3,
        29847: 4
    };
    return colorChannels[format - 6402] || 1;
};

var computeUnpackAlignedImageSize = (width, height, sizePerPixel) => {
    function roundedToNextMultipleOf(x, y) {
        return x + y - 1 & -y;
    }
    var plainRowSize = (GL.unpackRowLength || width) * sizePerPixel;
    var alignedRowSize = roundedToNextMultipleOf(plainRowSize, GL.unpackAlignment);
    return height * alignedRowSize;
};

var HEAPU16;

var heapObjectForWebGLType = type => {
    type -= 5120;
    if (type == 0) return HEAP8;
    if (type == 1) return HEAPU8;
    if (type == 2) return HEAP16;
    if (type == 4) return HEAP32;
    if (type == 6) return HEAPF32;
    if (type == 5 || type == 28922 || type == 28520 || type == 30779 || type == 30782) return HEAPU32;
    return HEAPU16;
};

var toTypedArrayIndex = (pointer, heap) => pointer >>> 31 - Math.clz32(heap.BYTES_PER_ELEMENT);

var emscriptenWebGLGetTexPixelData = (type, format, width, height, pixels) => {
    var heap = heapObjectForWebGLType(type);
    var sizePerPixel = colorChannelsInGlTextureFormat(format) * heap.BYTES_PER_ELEMENT;
    var bytes = computeUnpackAlignedImageSize(width, height, sizePerPixel);
    return heap.subarray(toTypedArrayIndex(pixels, heap) >>> 0, toTypedArrayIndex(pixels + bytes, heap) >>> 0);
};

function _emscripten_glTexSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels) {
    pixels >>>= 0;
    if (true) {
        if (GLctx.currentPixelUnpackBufferBinding) {
            GLctx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels);
            return;
        }
    }
    var pixelData = pixels ? emscriptenWebGLGetTexPixelData(type, format, width, height, pixels) : null;
    GLctx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixelData);
}

function _emscripten_glTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels) {
    pixels >>>= 0;
    if (GLctx.currentPixelUnpackBufferBinding) {
        GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels);
    } else if (pixels) {
        var heap = heapObjectForWebGLType(type);
        var pixelData = emscriptenWebGLGetTexPixelData(type, format, width, height * depth, pixels);
        GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixelData);
    } else {
        GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, null);
    }
}

var webglGetProgramUniformLocation = (program, location) => {
    if (program) {
        var webglLoc = program.uniformLocsById[location];
        if (typeof webglLoc === "number") {
            program.uniformLocsById[location] = webglLoc = GLctx.getUniformLocation(program, program.uniformArrayNamesById[location] + (webglLoc > 0 ? `[${webglLoc}]` : ""));
        }
        return webglLoc;
    } else {
        GL.recordError(1282);
    }
};

var webglGetUniformLocation = location => webglGetProgramUniformLocation(GLctx.currentProgram, location);

var _emscripten_glUniform1i = (location, v0) => {
    GLctx.uniform1i(webglGetUniformLocation(location), v0);
};

const GL_POOL_TEMP_BUFFERS_SIZE = 288;

var miniTempWebGLIntBuffers = [];

function _emscripten_glUniform1iv(location, count, value) {
    value >>>= 0;
    if (count <= GL_POOL_TEMP_BUFFERS_SIZE) {
        var view = miniTempWebGLIntBuffers[count];
        for (var i = 0; i < count; ++i) {
            view[i] = HEAP32[value + 4 * i >>> 2 >>> 0];
        }
    } else {
        var view = HEAP32.subarray(value >>> 2 >>> 0, value + count * 4 >>> 2 >>> 0);
    }
    GLctx.uniform1iv(webglGetUniformLocation(location), view);
}

var _emscripten_glUniformBlockBinding = (program, uniformBlockIndex, uniformBlockBinding) => {
    program = GL.programs[program];
    GLctx.uniformBlockBinding(program, uniformBlockIndex, uniformBlockBinding);
};

var _emscripten_glUseProgram = program => {
    program = GL.programs[program];
    GLctx.useProgram(program);
    GLctx.currentProgram = program;
};

var _emscripten_glVertexAttrib4f = (x0, x1, x2, x3, x4) => GLctx.vertexAttrib4f(x0, x1, x2, x3, x4);

var _emscripten_glVertexAttribDivisor = (index, divisor) => {
    GLctx.vertexAttribDivisor(index, divisor);
};

function _emscripten_glVertexAttribIPointer(index, size, type, stride, ptr) {
    ptr >>>= 0;
    GLctx.vertexAttribIPointer(index, size, type, stride, ptr);
}

function _emscripten_glVertexAttribPointer(index, size, type, normalized, stride, ptr) {
    ptr >>>= 0;
    GLctx.vertexAttribPointer(index, size, type, !!normalized, stride, ptr);
}

var _emscripten_glViewport = (x0, x1, x2, x3) => GLctx.viewport(x0, x1, x2, x3);

var _uewg_begin_pass = function(jsonPtr) {
    const g = Module.uewg;
    g.passBudget();
    g.endPass(true);
    const d = JSON.parse(UTF8ToString(jsonPtr >>> 0));
    const colorAttachments = d.color.map(c => c ? {
        view: g.o[c.view],
        loadOp: "load",
        storeOp: "store",
        depthSlice: c.slice >= 0 ? c.slice : undefined
    } : null);
    let depthStencilAttachment;
    if (d.depth) {
        const z = d.depth;
        depthStencilAttachment = {
            view: g.o[z.view]
        };
        if (z.ro & 1) depthStencilAttachment.depthReadOnly = true; else Object.assign(depthStencilAttachment, {
            depthLoadOp: "load",
            depthStoreOp: "store"
        });
        if (z.stencil) {
            if (z.ro & 2) depthStencilAttachment.stencilReadOnly = true; else Object.assign(depthStencilAttachment, {
                stencilLoadOp: "load",
                stencilStoreOp: "store"
            });
        }
    }
    g.lastPass = {
        colorAttachments: colorAttachments,
        depthStencilAttachment: depthStencilAttachment
    };
    let first = g.lastPass;
    if (g.pendClears.length) {
        const ca = colorAttachments.map(a => a && {
            ...a
        }), za = depthStencilAttachment && {
            ...depthStencilAttachment
        };
        for (const pc of g.pendClears) {
            for (const c of pc.color) {
                if (!c) continue;
                const k = ca.findIndex(a => a && a.view === c.view && (a.depthSlice ?? -1) === (c.slice >= 0 ? c.slice : -1));
                if (k >= 0) {
                    ca[k].loadOp = "clear";
                    ca[k].clearValue = c.clear;
                    c.view = null;
                }
            }
            if (pc.depth && za && za.view === pc.depth.view && !za.depthReadOnly && !(pc.depth.stencil && pc.depth.sclear !== undefined && za.stencilReadOnly)) {
                if (pc.depth.dclear !== undefined) {
                    za.depthLoadOp = "clear";
                    za.depthClearValue = pc.depth.dclear;
                }
                if (pc.depth.sclear !== undefined && za.stencilLoadOp) {
                    za.stencilLoadOp = "clear";
                    za.stencilClearValue = pc.depth.sclear;
                }
                pc.depth = null;
            }
            pc.color = pc.color.filter(c => c && c.view);
        }
        g.pendClears = g.pendClears.filter(pc => pc.color.length || pc.depth);
        g.flushClears();
        first = {
            colorAttachments: ca,
            depthStencilAttachment: za
        };
    }
    g.stat.pass++;
    g.pass = g.encoder().beginRenderPass(first);
    if (g.cap) g.cap.cur = {
        pass: g.cap.events.length,
        desc: g.lastPass,
        draws: []
    };
};

var _uewg_bindgroup_create = function(layoutId, group, jsonPtr) {
    const g = Module.uewg;
    if (window.uewLogCreates > 1) console.log(`[create] bindgroup`);
    g.stat.bg++;
    const layout = layoutId < 0 ? g.emptyLayout : g.o[layoutId].bgls[group];
    const entries = JSON.parse(UTF8ToString(jsonPtr >>> 0)).map(e => {
        if (e.ring) return {
            binding: e.b,
            resource: {
                buffer: g.ring,
                offset: e.off || 0,
                size: e.size
            }
        };
        if (e.buf !== undefined) return {
            binding: e.b,
            resource: {
                buffer: g.o[e.buf],
                offset: e.off || 0,
                size: e.size
            }
        };
        if (e.dummy) {
            const x = g.dummy(e.dummy);
            return {
                binding: e.b,
                resource: x instanceof GPUBuffer ? {
                    buffer: x
                } : x
            };
        }
        return {
            binding: e.b,
            resource: g.o[e.id]
        };
    });
    try {
        const bg = g.device.createBindGroup({
            layout: layout,
            entries: entries
        });
        if (g.capFrame) bg.__sz = JSON.parse(UTF8ToString(jsonPtr >>> 0)).filter(e => e.ring).map(e => [ e.b, e.off || -1, e.size ]);
        if (g.capFrame) bg.__r = entries.map(e => e.resource && e.resource.__tex ? e.resource.__tex.__id : e.resource && e.resource.buffer ? "b" : e.resource instanceof GPUSampler ? "s" : "?");
        return g.add(bg);
    } catch (e) {
        if (g.errors++ < 40) console.log("[webgpu] bind group " + e.message);
        return 0;
    }
};

function _uewg_buffer_copy(src, srcOff, dst, dstOff, size) {
    const g = Module.uewg, a = g.o[src], b = g.o[dst];
    if (!a || !b) return;
    g.endPass();
    const n = Math.min(size, a.size - srcOff, b.size - dstOff) & ~3;
    if (n > 0) g.encoder().copyBufferToBuffer(a, srcOff, b, dstOff, n);
}

function _uewg_buffer_copy_ring(ringOff, dst, dstOff, size, ringUsed) {
    const g = Module.uewg, b = g.o[dst];
    if (!b) return;
    g.endPass();
    const n = Math.min(size, b.size - dstOff);
    if (n > 0) {
        g.encoder().copyBufferToBuffer(g.ring, ringOff, b, dstOff, n);
        g.stat.ringCopy++;
    }
}

function _uewg_buffer_create(size, usage) {
    const g = Module.uewg;
    let u = GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    if (usage & 1) u |= GPUBufferUsage.VERTEX;
    if (usage & 2) u |= GPUBufferUsage.INDEX;
    if (usage & 4) u |= GPUBufferUsage.UNIFORM;
    if (usage & 8) u |= GPUBufferUsage.STORAGE;
    if (usage & 16) u |= GPUBufferUsage.INDIRECT;
    try {
        return g.add(g.device.createBuffer({
            size: Math.max(256, size + 255 & ~255),
            usage: u
        }));
    } catch (e) {
        console.log("[webgpu] buffer " + e.message);
        return 0;
    }
}

function _uewg_buffer_write(id, offset, ptr, size) {
    ptr >>>= 0;
    const g = Module.uewg, b = g.o[id];
    if (!b) return;
    const n = Math.min(size + 3 & ~3, b.size - offset);
    if (n > 0) {
        g.queue.writeBuffer(b, offset, HEAPU8, ptr, n);
        g.stat.write++;
        g.stat.writeBytes += n;
        if (g.stat.by) g.stat.by.set(id, [ (g.stat.by.get(id) || [ 0 ])[0] + n, b.size, offset ]);
    }
}

function _uewg_clear(jsonPtr, ringUsed) {
    const g = Module.uewg;
    g.endPass(true);
    const d = JSON.parse(UTF8ToString(jsonPtr >>> 0));
    g.capEvent({
        clear: JSON.parse(JSON.stringify(d))
    });
    for (const c of d.color) c.view = g.o[c.view];
    if (d.depth) d.depth.view = g.o[d.depth.view];
    for (const pc of g.pendClears) {
        pc.color = pc.color.filter(c => !d.color.some(n => n.view === c.view && n.slice === c.slice));
        if (pc.depth && d.depth && pc.depth.view === d.depth.view && d.depth.dclear !== undefined && (d.depth.sclear !== undefined || !pc.depth.stencil)) pc.depth = null;
    }
    g.pendClears = g.pendClears.filter(pc => pc.color.length || pc.depth);
    g.pendClears.push(d);
}

function _uewg_clear_buffer(id, off, size) {
    const g = Module.uewg, b = g.o[id];
    if (!b) return;
    g.endPass();
    const n = Math.min(size, b.size - off) & ~3;
    if (n > 0) g.encoder().clearBuffer(b, off, n);
}

function _uewg_compute_pipeline_create(layoutId, cs) {
    const g = Module.uewg;
    const desc = {
        layout: g.o[layoutId].pl,
        compute: {
            module: g.o[cs],
            entryPoint: "main"
        }
    };
    const done = p => {
        p.__cs = cs;
        p.__ps = cs;
        return p;
    };
    if (g.asyncShaders()) {
        const id = g.add(null);
        g.pendingPipes++;
        g.pending.add(id);
        g.device.createComputePipelineAsync(desc).then(p => {
            g.o[id] = done(p);
            g.pendingPipes--;
            g.pending.delete(id);
            Module.uewWake && Module.uewWake();
        }, e => {
            g.pendingPipes--;
            g.pending.delete(id);
            Module.uewWake && Module.uewWake();
            if (g.errors++ < 40) console.log("[webgpu] compute pipeline " + e.message);
        });
        return id;
    }
    try {
        return g.add(done(g.device.createComputePipeline(desc)));
    } catch (e) {
        if (g.errors++ < 40) console.log("[webgpu] compute pipeline " + e.message);
        return 0;
    }
}

function _uewg_copy_buffer(src, soff, dst, doff, size) {
    const g = Module.uewg, s = g.o[src], d = g.o[dst];
    if (!s || !d) return;
    g.endPass();
    const n = Math.min(size + 3 & ~3, s.size - soff, d.size - doff);
    if (n > 0) g.encoder().copyBufferToBuffer(s, soff, d, doff, n);
}

var _uewg_copy_texture = function(src, smip, slayer, sx, sy, sz, dst, dmip, dlayer, dx, dy, dz, w, h, d) {
    const g = Module.uewg;
    g.endPass();
    const isC = t => t && /^(bc|etc2|eac|astc)/.test(t.format);
    if (g.o[src] && g.o[dst] && isC(g.o[src]) !== isC(g.o[dst])) {
        const ct = isC(g.o[src]) ? g.o[src] : g.o[dst], bpu = /^(bc1|bc4)/.test(ct.format) ? 8 : 16;
        const uw = isC(g.o[src]) ? w + 3 >> 2 : w, uh = isC(g.o[src]) ? h + 3 >> 2 : h;
        const se = isC(g.o[src]) ? [ uw * 4, uh * 4, d ] : [ uw, uh, d ], de = isC(g.o[src]) ? [ uw, uh, d ] : [ uw * 4, uh * 4, d ];
        const bytesPerRow = uw * bpu + 255 & ~255;
        try {
            const buf = g.device.createBuffer({
                size: bytesPerRow * uh * d,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            });
            const enc = g.encoder();
            enc.copyTextureToBuffer({
                texture: g.o[src],
                mipLevel: smip,
                origin: [ sx, sy, sz + slayer ]
            }, {
                buffer: buf,
                bytesPerRow: bytesPerRow,
                rowsPerImage: uh
            }, se);
            enc.copyBufferToTexture({
                buffer: buf,
                bytesPerRow: bytesPerRow,
                rowsPerImage: uh
            }, {
                texture: g.o[dst],
                mipLevel: dmip,
                origin: [ dx, dy, dz + dlayer ]
            }, de);
        } catch (e) {
            if (g.errors++ < 40) console.log("[webgpu] copy " + e.message);
        }
        return;
    }
    if (isC(g.o[src])) {
        w = w + 3 & ~3;
        h = h + 3 & ~3;
    }
    try {
        g.encoder().copyTextureToTexture({
            texture: g.o[src],
            mipLevel: smip,
            origin: [ sx, sy, sz + slayer ]
        }, {
            texture: g.o[dst],
            mipLevel: dmip,
            origin: [ dx, dy, dz + dlayer ]
        }, [ w, h, d ]);
        g.capEvent({
            copy: [ src, smip, slayer, dst, dmip, dlayer, w, h, d ]
        });
    } catch (e) {
        if (g.errors++ < 40) console.log("[webgpu] copy " + e.message);
    }
};

var _uewg_dispatch = function(p) {
    Module.uewg.guard("dispatch", () => {
        const g = Module.uewg, I = HEAP32;
        let i = p >>> 2;
        const pipe = g.o[I[i++]];
        const cb = I[i++], ndyn = I[i++];
        const dyn0 = i;
        i += ndyn;
        const res = I[i++], x = I[i++], y = I[i++], z = I[i++];
        if (!pipe) return;
        g.passBudget();
        g.endPass();
        const cp = g.encoder().beginComputePass();
        cp.setPipeline(pipe);
        if (g.prof && g.prof.cur) {
            g.prof.cur.draws++;
            g.prof.cur.pipes.set(I[p >>> 2], 1);
        }
        cp.setBindGroup(0, g.o[cb], HEAPU32, dyn0, ndyn);
        cp.setBindGroup(1, g.o[res]);
        if (x === -1) cp.dispatchWorkgroupsIndirect(g.o[y], z); else cp.dispatchWorkgroups(x, y, z);
        cp.end();
        if (g.cap) g.capEvent({
            dispatch: [ x, y, z ],
            cs: pipe.__cs,
            res: g.o[res] && g.o[res].__r
        });
    });
};

var _uewg_draw = function(p) {
    Module.uewg.guard("draw", () => {
        const g = Module.uewg;
        if (!g.pass && g.lastPass) {
            g.stat.reopen++;
            g.openPass();
        }
        const pass = g.pass;
        if (!pass) {
            g.skip.nopass++;
            return;
        }
        const I = HEAP32, F = HEAPF32;
        let i = p >>> 2;
        const pipeId = I[i++], pipe = g.o[pipeId];
        if (!pipe) {
            g.skip.nopipe++;
            return;
        }
        let st = g.pst;
        if (!st || st.pass !== pass) {
            st = g.pst = {
                pass: pass,
                pipe: -1,
                bg: new Int32Array(4).fill(-1),
                off: new Uint32Array(32),
                nd: new Int32Array(4),
                vb: new Int32Array(48).fill(-2),
                vp: new Float32Array(6).fill(NaN),
                sc: new Int32Array(4).fill(-1),
                sref: -1,
                bc: new Float32Array(4).fill(NaN),
                ib: new Int32Array(3).fill(-2)
            };
        }
        if (st.pipe !== pipeId) {
            pass.setPipeline(pipe);
            st.pipe = pipeId;
        }
        if (g.prof && g.prof.cur) {
            const c = g.prof.cur;
            c.draws++;
            c.pipes.set(pipeId, (c.pipes.get(pipeId) || 0) + 1);
        }
        const ngroups = I[i++];
        for (let k = 0, j = i; k < ngroups; k++) {
            if (!g.o[I[j]]) {
                g.skip.nobg = (g.skip.nobg || 0) + 1;
                if ((g.nobgLogged = (g.nobgLogged || 0) + 1) <= 5) console.log(`[webgpu] draw skipped: bind group ${k} (id ${I[j]}) is missing, pipeline ${pipeId}`);
                return;
            }
            j += 2 + I[j + 1];
        }
        for (let k = 0; k < ngroups; k++) {
            const bg = I[i++], ndyn = I[i++];
            let same = st.bg[k] === bg && st.nd[k] === ndyn;
            for (let d = 0; d < ndyn && same; d++) if (st.off[k * 8 + d] !== HEAPU32[i + d >>> 0]) same = false;
            if (!same) {
                pass.setBindGroup(k, g.o[bg], HEAPU32, i, ndyn);
                st.bg[k] = bg;
                st.nd[k] = ndyn;
                for (let d = 0; d < ndyn && d < 8; d++) st.off[k * 8 + d] = HEAPU32[i + d >>> 0];
            }
            i += ndyn;
        }
        const nvb = I[i++];
        for (let k = 0; k < nvb; k++) {
            const slot = I[i], id = I[i + 1], off = I[i + 2], o = slot * 3;
            if (st.vb[o] !== id || st.vb[o + 1] !== off) {
                pass.setVertexBuffer(slot, id < 0 ? g.zeroVB() : g.o[id], off);
                st.vb[o] = id;
                st.vb[o + 1] = off;
            }
            i += 3;
        }
        if (st.vp[0] !== F[i] || st.vp[1] !== F[i + 1] || st.vp[2] !== F[i + 2] || st.vp[3] !== F[i + 3] || st.vp[4] !== F[i + 4] || st.vp[5] !== F[i + 5]) {
            pass.setViewport(F[i], F[i + 1], F[i + 2], F[i + 3], F[i + 4], F[i + 5]);
            st.vp.set(F.subarray(i, i + 6));
        }
        i += 6;
        if (st.sc[0] !== I[i] || st.sc[1] !== I[i + 1] || st.sc[2] !== I[i + 2] || st.sc[3] !== I[i + 3]) {
            pass.setScissorRect(I[i], I[i + 1], I[i + 2], I[i + 3]);
            st.sc.set(I.subarray(i, i + 4));
        }
        i += 4;
        const sref = I[i] >>> 0;
        if (st.sref !== sref) {
            pass.setStencilReference(sref);
            st.sref = sref;
        }
        i++;
        if (st.bc[0] !== F[i] || st.bc[1] !== F[i + 1] || st.bc[2] !== F[i + 2] || st.bc[3] !== F[i + 3]) {
            pass.setBlendConstant([ F[i], F[i + 1], F[i + 2], F[i + 3] ]);
            st.bc.set(F.subarray(i, i + 4));
        }
        i += 4;
        const indexed = I[i++], count = I[i++], instances = I[i++], first = I[i++], baseVertex = I[i++], firstInstance = I[i++];
        if (indexed) {
            if (st.ib[0] !== I[i] || st.ib[1] !== I[i + 1] || st.ib[2] !== I[i + 2]) {
                pass.setIndexBuffer(g.o[I[i]], I[i + 1] ? "uint32" : "uint16", I[i + 2]);
                st.ib.set(I.subarray(i, i + 3));
            }
            if (count === -1) pass.drawIndexedIndirect(g.o[instances], first); else pass.drawIndexed(count, instances, first, baseVertex, firstInstance);
            g.stat.draws++;
        } else if (count === -1) pass.drawIndirect(g.o[instances], first); else pass.draw(count, instances, first, firstInstance);
        if (g.cap && g.cap.cur && g.cap.cur.draws.length < 3e3) {
            const pd = pipe.__d || {};
            const groups = [], cbs = {};
            for (let k = 0, j = (p >>> 2) + 2; k < ngroups; k++) {
                const bg = g.o[I[j]], nd = I[j + 1];
                groups.push(bg && bg.__r);
                if (bg && bg.__sz && g.cap.cur.draws.length < 8) {
                    let d = 0;
                    for (const [b, off, size] of bg.__sz) {
                        const o = off >= 0 ? off : HEAPU32[j + 2 + d++ >>> 0];
                        cbs[`${k}:${b}`] = Array.from(HEAPF32.subarray(g.ringPtr + o >>> 2 >>> 0, g.ringPtr + o + size >>> 2 >>> 0)).map(x => +x.toPrecision(5));
                    }
                }
                j += 2 + nd;
            }
            g.cap.cur.draws.push({
                vs: pd.vs,
                ps: pd.ps,
                count: count,
                instances: instances,
                indexed: indexed,
                first: first,
                baseVertex: baseVertex,
                topo: pd.primitive && pd.primitive.topology,
                targets: pd.targets,
                depth: pd.depth,
                buffers: pd.buffers,
                prim: pd.primitive,
                vp: Array.from(st.vp),
                sc: Array.from(st.sc),
                sref: sref,
                res: groups,
                cbs: cbs
            });
            if (window.uewCapturePixels && g.cap.px.length < 400) {
                pass.end();
                const enc = g.encoder(), atts = [];
                const z = g.lastPass.depthStencilAttachment, zt = z && z.view.__tex;
                if (zt && zt.format === "depth32float-stencil8") atts.push([ "z", zt, "depth-only", 4 ]);
                const c0 = g.lastPass.colorAttachments[0], ct = c0 && c0.view.__tex;
                if (ct && ct.format === "rgba16float" && ct.dimension === "2d") atts.push([ "c", ct, "all", 8 ]);
                for (const [kind, t, aspect, bpp] of atts) {
                    const bpr = t.width * bpp + 255 & ~255;
                    const buf = g.device.createBuffer({
                        size: bpr * t.height,
                        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                    });
                    enc.copyTextureToBuffer({
                        texture: t,
                        aspect: aspect
                    }, {
                        buffer: buf,
                        bytesPerRow: bpr,
                        rowsPerImage: t.height
                    }, [ t.width, t.height, 1 ]);
                    g.cap.px.push({
                        buf: buf,
                        kind: kind,
                        bpr: bpr,
                        bpp: bpp,
                        w: t.width,
                        h: t.height,
                        pass: g.cap.cur.pass,
                        draw: g.cap.cur.draws.length - 1,
                        ps: pd.ps,
                        vs: pd.vs,
                        n: count,
                        first: first
                    });
                }
                g.pass = g.encoder().beginRenderPass(g.lastPass);
            }
            const a0 = window.uewCapturePerDraw && g.lastPass.colorAttachments[0], t0 = a0 && a0.view.__tex;
            if (t0 && t0.format === "rgba16float" && t0.dimension === "2d" && g.cap.perDraw.length < 200) {
                g.pass.end();
                const w = t0.width, h = t0.height, bpr = w * 8 + 255 & ~255;
                const buf = g.device.createBuffer({
                    size: bpr * h,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                });
                g.encoder().copyTextureToBuffer({
                    texture: t0
                }, {
                    buffer: buf,
                    bytesPerRow: bpr,
                    rowsPerImage: h
                }, [ w, h, 1 ]);
                g.cap.perDraw.push({
                    buf: buf,
                    w: w,
                    h: h,
                    bpr: bpr,
                    pass: g.cap.cur.pass,
                    draw: g.cap.cur.draws.length - 1,
                    ps: pd.ps,
                    tex: t0.__id
                });
                g.pass = g.encoder().beginRenderPass(g.lastPass);
            }
        }
        g.draws++;
    });
};

function _uewg_expand_typed(srcId, dstId, first, n, fmt, bpe) {
    const g = Module.uewg, src = g.o[srcId], dst = g.o[dstId];
    if (!src || !dst || !n) return;
    if (!g.expand) {
        const m = g.device.createShaderModule({
            code: `struct P { first: u32, n: u32, fmt: u32, bpe: u32 }\n@group(0) @binding(0) var<storage, read> src: array<u32>;\n@group(0) @binding(1) var<storage, read_write> dst: array<vec4<u32>>;\n@group(0) @binding(2) var<uniform> p: P;\nfn b8(o: u32) -> u32 { return (src[o >> 2u] >> ((o & 3u) * 8u)) & 0xFFu; }\nfn b16(o: u32) -> u32 { return b8(o) | (b8(o + 1u) << 8u); }\nfn w32(o: u32) -> u32 { return b16(o) | (b16(o + 2u) << 16u); }\nfn fb(x: f32) -> u32 { return bitcast<u32>(x); }\nfn h(o: u32) -> u32 { return fb(unpack2x16float(b16(o)).x); }\nfn un8(o: u32) -> u32 { return fb(f32(b8(o)) / 255.0); }\nfn sn8(o: u32) -> u32 { return fb(max(f32(i32(b8(o) << 24u) >> 24u) / 127.0, -1.0)); }\nfn un16(o: u32) -> u32 { return fb(f32(b16(o)) / 65535.0); }\nfn sn16(o: u32) -> u32 { return fb(max(f32(i32(b16(o) << 16u) >> 16u) / 32767.0, -1.0)); }\nfn si8(o: u32) -> u32 { return bitcast<u32>(i32(b8(o) << 24u) >> 24u); }\nfn si16(o: u32) -> u32 { return bitcast<u32>(i32(b16(o) << 16u) >> 16u); }\nfn small(v: u32, sh: u32) -> u32 { return fb(unpack2x16float(v << sh).x); }\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {\n  let i = id.x;\n  if (i >= p.n) { return; }\n  let o = (p.first + i) * p.bpe;\n  var r = vec4<u32>(0u, 0u, 0u, 0x3F800000u);\n  switch p.fmt {\n    case 2u, 3u, 4u: { r = vec4<u32>(w32(o), w32(o + 4u), w32(o + 8u), w32(o + 12u)); }\n    case 6u, 7u, 8u: { r.x = w32(o); r.y = w32(o + 4u); r.z = w32(o + 8u); }\n    case 16u, 17u, 18u: { r.x = w32(o); r.y = w32(o + 4u); }\n    case 10u: { r = vec4<u32>(h(o), h(o + 2u), h(o + 4u), h(o + 6u)); }\n    case 34u: { r.x = h(o); r.y = h(o + 2u); }\n    case 54u: { r.x = h(o); }\n    case 28u, 29u: { r = vec4<u32>(un8(o), un8(o + 1u), un8(o + 2u), un8(o + 3u)); }\n    case 87u: { r = vec4<u32>(un8(o + 2u), un8(o + 1u), un8(o), un8(o + 3u)); }\n    case 88u: { r.x = un8(o + 2u); r.y = un8(o + 1u); r.z = un8(o); }\n    case 30u: { r = vec4<u32>(b8(o), b8(o + 1u), b8(o + 2u), b8(o + 3u)); }\n    case 12u: { r = vec4<u32>(b16(o), b16(o + 2u), b16(o + 4u), b16(o + 6u)); }\n    case 36u: { r.x = b16(o); r.y = b16(o + 2u); }\n    case 57u: { r.x = b16(o); }\n    case 62u: { r.x = b8(o); }\n    case 61u: { r.x = un8(o); }\n    case 56u: { r.x = un16(o); }\n    case 35u: { r.x = un16(o); r.y = un16(o + 2u); }\n    case 11u: { r = vec4<u32>(un16(o), un16(o + 2u), un16(o + 4u), un16(o + 6u)); }\n    case 31u: { r = vec4<u32>(sn8(o), sn8(o + 1u), sn8(o + 2u), sn8(o + 3u)); }\n    case 51u: { r.x = sn8(o); r.y = sn8(o + 1u); }\n    case 63u: { r.x = sn8(o); }\n    case 13u: { r = vec4<u32>(sn16(o), sn16(o + 2u), sn16(o + 4u), sn16(o + 6u)); }\n    case 37u: { r.x = sn16(o); r.y = sn16(o + 2u); }\n    case 58u: { r.x = sn16(o); }\n    case 49u: { r.x = un8(o); r.y = un8(o + 1u); }\n    case 50u: { r.x = b8(o); r.y = b8(o + 1u); }\n    case 32u: { r = vec4<u32>(si8(o), si8(o + 1u), si8(o + 2u), si8(o + 3u)); }\n    case 52u: { r.x = si8(o); r.y = si8(o + 1u); }\n    case 64u: { r.x = si8(o); }\n    case 14u: { r = vec4<u32>(si16(o), si16(o + 2u), si16(o + 4u), si16(o + 6u)); }\n    case 38u: { r.x = si16(o); r.y = si16(o + 2u); }\n    case 59u: { r.x = si16(o); }\n    case 24u: { let v = w32(o); r = vec4<u32>(fb(f32(v & 1023u) / 1023.0), fb(f32((v >> 10u) & 1023u) / 1023.0), fb(f32((v >> 20u) & 1023u) / 1023.0), fb(f32(v >> 30u) / 3.0)); }\n    case 25u: { let v = w32(o); r = vec4<u32>(v & 1023u, (v >> 10u) & 1023u, (v >> 20u) & 1023u, v >> 30u); }\n    case 26u: { let v = w32(o); r.x = small(v & 2047u, 4u); r.y = small((v >> 11u) & 2047u, 4u); r.z = small(v >> 22u, 5u); }\n    default: { r.x = w32(o); }\n  }\n  dst[i] = r;\n}`
        });
        g.expand = g.device.createComputePipeline({
            layout: "auto",
            compute: {
                module: m,
                entryPoint: "main"
            }
        });
    }
    const ub = g.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    g.queue.writeBuffer(ub, 0, new Uint32Array([ first, n, fmt, bpe ]));
    const bg = g.device.createBindGroup({
        layout: g.expand.getBindGroupLayout(0),
        entries: [ {
            binding: 0,
            resource: {
                buffer: src
            }
        }, {
            binding: 1,
            resource: {
                buffer: dst
            }
        }, {
            binding: 2,
            resource: {
                buffer: ub
            }
        } ]
    });
    g.endPass();
    const cp = g.encoder().beginComputePass();
    cp.setPipeline(g.expand);
    cp.setBindGroup(0, bg);
    cp.dispatchWorkgroups(Math.ceil(n / 64));
    cp.end();
    (g.expandTmp || (g.expandTmp = [])).push(ub);
}

function _uewg_flush(ringUsed) {
    Module.uewg.flush(ringUsed);
    Module.uewg.ringDone = 0;
}

var _uewg_gen_mips = function(id) {
    Module.uewg.guard("mips", () => {
        const g = Module.uewg, t = g.o[id];
        if (!(t instanceof GPUTexture) || t.mipLevelCount < 2 || t.dimension !== "2d" || /^(bc|depth|stencil)|int$/.test(t.format)) return;
        g.endPass();
        if (!g.mipMod) {
            g.mipMod = g.device.createShaderModule({
                code: `@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;\n        struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };\n        @vertex fn vs(@builtin(vertex_index) i: u32) -> V { let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)); var o: V; o.p = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0); o.uv = uv; return o; }\n        @fragment fn fs(v: V) -> @location(0) vec4<f32> { return textureSampleLevel(t, s, v.uv, 0.0); }`
            });
            g.mipSampler = g.device.createSampler({
                magFilter: "linear",
                minFilter: "linear"
            });
            g.mipPipes = new Map;
        }
        let pipe = g.mipPipes.get(t.format);
        if (!pipe) {
            pipe = g.device.createRenderPipeline({
                layout: "auto",
                vertex: {
                    module: g.mipMod,
                    entryPoint: "vs"
                },
                fragment: {
                    module: g.mipMod,
                    entryPoint: "fs",
                    targets: [ {
                        format: t.format
                    } ]
                }
            });
            g.mipPipes.set(t.format, pipe);
        }
        const enc = g.encoder();
        for (let layer = 0; layer < t.depthOrArrayLayers; layer++) for (let m = 1; m < t.mipLevelCount; m++) {
            const view = k => t.createView({
                dimension: "2d",
                baseMipLevel: k,
                mipLevelCount: 1,
                baseArrayLayer: layer,
                arrayLayerCount: 1
            });
            const bg = g.device.createBindGroup({
                layout: pipe.getBindGroupLayout(0),
                entries: [ {
                    binding: 0,
                    resource: view(m - 1)
                }, {
                    binding: 1,
                    resource: g.mipSampler
                } ]
            });
            const p = enc.beginRenderPass({
                colorAttachments: [ {
                    view: view(m),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: [ 0, 0, 0, 0 ]
                } ]
            });
            p.setPipeline(pipe);
            p.setBindGroup(0, bg);
            p.draw(3);
            p.end();
        }
    });
};

var _uewg_gs = function(p) {
    Module.uewg.guard("gs", () => {
        const g = Module.uewg, I = HEAP32, F = HEAPF32;
        let i = p >>> 2;
        const cpipe = g.o[I[i++]], wx = I[i++], wy = I[i++], nl = I[i++], cap = I[i++], args = g.o[I[i++]];
        const groups = () => {
            const r = [];
            for (let k = 0; k < 4; k++) {
                const bg = I[i++], nd = I[i++];
                r.push([ g.o[bg], i, nd ]);
                i += nd;
            }
            return r;
        };
        const cg = groups();
        const rpipe = g.o[I[i++]];
        const rg = groups();
        const vp = [ F[i], F[i + 1], F[i + 2], F[i + 3], F[i + 4], F[i + 5] ];
        i += 6;
        const sc = [ I[i], I[i + 1], I[i + 2], I[i + 3] ];
        i += 4;
        const sref = I[i++] >>> 0, bc = [ F[i], F[i + 1], F[i + 2], F[i + 3] ];
        i += 4;
        const ncol = I[i++], hasDepth = I[i++], stencil = I[i++], ro = I[i++];
        if (!cpipe || !rpipe || !args) {
            g.skip.nopipe++;
            return;
        }
        g.endPass();
        const enc = g.encoder();
        enc.clearBuffer(args, 0, nl * 16);
        if (!g.gsFix) {
            const m = g.device.createShaderModule({
                code: `@group(0) @binding(0) var<storage, read_write> a: array<u32>; @group(0) @binding(1) var<uniform> q: vec4<u32>;\n        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) { let l = id.x; if (l >= q.y) { return; }\n        a[l * 4u] = min(a[l * 4u], q.x); a[l * 4u + 1u] = 1u; a[l * 4u + 2u] = l * q.x; a[l * 4u + 3u] = 0u; }`
            });
            g.gsFix = g.device.createComputePipeline({
                layout: "auto",
                compute: {
                    module: m,
                    entryPoint: "main"
                }
            });
            g.gsFixUB = new Map;
        }
        const key = cap + ":" + nl;
        let ub = g.gsFixUB.get(key);
        if (!ub) {
            ub = g.device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
            g.queue.writeBuffer(ub, 0, new Uint32Array([ cap, nl, 0, 0 ]));
            g.gsFixUB.set(key, ub);
        }
        const cp = enc.beginComputePass();
        cp.setPipeline(cpipe);
        for (let k = 0; k < 4; k++) cp.setBindGroup(k, cg[k][0], HEAPU32, cg[k][1], cg[k][2]);
        cp.dispatchWorkgroups(wx, wy);
        cp.setPipeline(g.gsFix);
        cp.setBindGroup(0, g.device.createBindGroup({
            layout: g.gsFix.getBindGroupLayout(0),
            entries: [ {
                binding: 0,
                resource: {
                    buffer: args
                }
            }, {
                binding: 1,
                resource: {
                    buffer: ub
                }
            } ]
        }));
        cp.dispatchWorkgroups(Math.ceil(nl / 64));
        cp.end();
        for (let L = 0; L < nl; L++) {
            const colorAttachments = [];
            for (let c = 0; c < ncol; c++) {
                const v = I[i++], sl = I[i++];
                colorAttachments.push(v ? {
                    view: g.o[v],
                    loadOp: "load",
                    storeOp: "store",
                    depthSlice: sl >= 0 ? sl : undefined
                } : null);
            }
            let depthStencilAttachment;
            if (hasDepth) {
                depthStencilAttachment = {
                    view: g.o[I[i++]]
                };
                if (ro & 1) depthStencilAttachment.depthReadOnly = true; else Object.assign(depthStencilAttachment, {
                    depthLoadOp: "load",
                    depthStoreOp: "store"
                });
                if (stencil) {
                    if (ro & 2) depthStencilAttachment.stencilReadOnly = true; else Object.assign(depthStencilAttachment, {
                        stencilLoadOp: "load",
                        stencilStoreOp: "store"
                    });
                }
            }
            const pass = enc.beginRenderPass({
                colorAttachments: colorAttachments,
                depthStencilAttachment: depthStencilAttachment
            });
            pass.setPipeline(rpipe);
            for (let k = 0; k < 4; k++) pass.setBindGroup(k, rg[k][0], HEAPU32, rg[k][1], rg[k][2]);
            pass.setViewport(vp[0], vp[1], vp[2], vp[3], vp[4], vp[5]);
            pass.setScissorRect(sc[0], sc[1], sc[2], sc[3]);
            pass.setStencilReference(sref);
            pass.setBlendConstant(bc);
            pass.drawIndirect(args, L * 16);
            pass.end();
        }
        g.capEvent({
            gs: nl,
            cap: cap
        });
        g.draws++;
    });
};

async function _uewg_init(canvasW, canvasH, ringPtr, ringSize) {
    ringPtr >>>= 0;
    if (!navigator.gpu) return 0;
    const adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance"
    });
    if (!adapter) return 0;
    const want = [ "texture-compression-bc", "texture-compression-bc-sliced-3d", "float32-filterable", "float32-blendable", "rg11b10ufloat-renderable", "depth32float-stencil8", "depth-clip-control", "indirect-first-instance", "texture-formats-tier1", "texture-formats-tier2", "texture-component-swizzle", "bgra8unorm-storage", "dual-source-blending" ];
    if (typeof window !== "undefined" && window.uewGpuProfile) want.push("timestamp-query");
    const features = want.filter(f => adapter.features.has(f));
    const L = adapter.limits, req = {};
    for (const k of [ "maxSampledTexturesPerShaderStage", "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage", "maxStorageTexturesPerShaderStage", "maxUniformBuffersPerShaderStage", "maxBindingsPerBindGroup", "maxInterStageShaderVariables", "maxColorAttachmentBytesPerSample", "maxBufferSize", "maxStorageBufferBindingSize", "maxDynamicUniformBuffersPerPipelineLayout", "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup", "maxTextureArrayLayers", "maxTextureDimension2D", "maxVertexAttributes", "maxVertexBuffers", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension", "maxTextureDimension3D", "maxTextureDimension1D", "maxBindGroups" ]) if (k in L) req[k] = L[k];
    let device;
    try {
        device = await adapter.requestDevice({
            requiredFeatures: features,
            requiredLimits: req
        });
    } catch (e) {
        console.log("[webgpu] requestDevice failed: " + e.message);
        return 0;
    }
    const canvas = Module.canvas || document.getElementById("canvas");
    const ctx = canvas && canvas.getContext("webgpu");
    if (!ctx) return 0;
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({
        device: device,
        format: format,
        alphaMode: "opaque"
    });
    const g = Module.uewg = {
        device: device,
        queue: device.queue,
        ctx: ctx,
        canvasFormat: format,
        o: [ null ],
        free: [],
        features: new Set(features),
        errors: 0,
        ring: device.createBuffer({
            size: ringSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        }),
        ringPtr: ringPtr,
        enc: null,
        pass: null,
        blit: null,
        frames: 0,
        draws: 0,
        dummies: new Map
    };
    g.errKinds = new Map;
    device.addEventListener("uncapturederror", e => {
        const m = e.error.message;
        if (g.errors++ < 40) console.log("[webgpu] " + m.split("\n").slice(0, 3).join(" | "));
        const kind = m.split("\n")[0].replace(/\[[^\]]*\]/g, "[]").replace(/\d+/g, "N").slice(0, 140);
        g.errKinds.set(kind, (g.errKinds.get(kind) || 0) + 1);
    });
    g.add = x => {
        if (g.free.length) {
            const i = g.free.pop();
            g.o[i] = x;
            return i;
        }
        g.o.push(x);
        return g.o.length - 1;
    };
    g.encoder = () => g.enc || (g.enc = device.createCommandEncoder());
    g.pendingPipes = 0;
    g.pending = new Set;
    g.skipPending = typeof location !== "undefined" && /[?&]skipshaders=1/.test(location.search);
    g.asyncShaders = () => {
        if (g.asyncMode === undefined) g.asyncMode = !(typeof location !== "undefined" && /[?&]syncshaders=1/.test(location.search)) && Module.uewAsyncShaders !== false;
        return g.asyncMode;
    };
    if (features.includes("timestamp-query")) {
        const N = 1024, P = g.prof = {
            N: N,
            qs: device.createQuerySet({
                type: "timestamp",
                count: N * 2
            }),
            n: 0,
            passes: [],
            cur: null,
            busy: false,
            res: device.createBuffer({
                size: N * 16,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
            }),
            shaders: new Map,
            shown: new Set
        };
        const wrap = enc => {
            const br = enc.beginRenderPass.bind(enc), bc = enc.beginComputePass.bind(enc);
            const stamp = (kind, d) => {
                if (P.n >= N) {
                    P.cur = null;
                    return d;
                }
                P.cur = {
                    kind: kind,
                    pipes: new Map,
                    draws: 0
                };
                P.passes.push(P.cur);
                const tw = {
                    querySet: P.qs,
                    beginningOfPassWriteIndex: P.n * 2,
                    endOfPassWriteIndex: P.n * 2 + 1
                };
                P.n++;
                return Object.assign({}, d || {}, {
                    timestampWrites: tw
                });
            };
            enc.beginRenderPass = d => br(stamp("render", d));
            enc.beginComputePass = d => bc(stamp("compute", d));
            return enc;
        };
        g.encoder = () => g.enc || (g.enc = wrap(device.createCommandEncoder()));
        P.frameEnd = () => {
            if (!P.n) return;
            if (P.busy) {
                P.n = 0;
                P.passes = [];
                return;
            }
            g.endPass();
            const n = P.n, passes = P.passes, enc = g.encoder();
            const out = device.createBuffer({
                size: n * 16,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });
            enc.resolveQuerySet(P.qs, 0, n * 2, P.res, 0);
            enc.copyBufferToBuffer(P.res, 0, out, 0, n * 16);
            P.n = 0;
            P.passes = [];
            P.busy = true;
            const frame = g.frames;
            setTimeout(() => out.mapAsync(GPUMapMode.READ).then(() => {
                const t = new BigInt64Array(out.getMappedRange());
                const ms = [];
                let total = 0;
                for (let i = 0; i < n; i++) {
                    const v = Number(t[2 * i + 1] - t[2 * i]) / 1e6;
                    ms.push(v > 0 && v < 1e4 ? v : 0);
                    total += ms[i];
                }
                out.unmap();
                out.destroy();
                P.busy = false;
                if (total < 12) return;
                const top = ms.map((v, i) => [ v, i ]).sort((a, b) => b[0] - a[0]).slice(0, 5);
                console.log(`[gpuprof] frame ${frame}: ${total.toFixed(1)} ms GPU in ${n} passes; slowest: ` + top.map(([v, i]) => {
                    const ps = passes[i], pp = [ ...ps.pipes ].sort((a, b) => b[1] - a[1]).slice(0, 3);
                    return `#${i} ${ps.kind} ${v.toFixed(1)} ms ${ps.draws} draws [` + pp.map(([id, c]) => {
                        const pl = g.o[id] || {};
                        return `pipe ${id} vs ${pl.__vs} ps ${pl.__ps} x${c}`;
                    }).join(", ") + "]";
                }).join(" | "));
                const worst = passes[top[0][1]];
                if (worst) for (const [id] of worst.pipes) {
                    const pl = g.o[id] || {}, sh = pl.__ps || pl.__cs;
                    if (sh && !P.shown.has(sh) && P.shown.size < 12 && P.shaders.has(sh)) {
                        P.shown.add(sh);
                        console.log(`[gpuprof] shader ${sh}:\n${P.shaders.get(sh)}`);
                        break;
                    }
                }
            }, () => {
                out.destroy();
                P.busy = false;
            }), 0);
        };
    }
    g.endPass = () => {
        if (g.pass) {
            g.pass.end();
            g.pass = null;
        }
    };
    g.passesInCb = 0;
    g.passBudget = () => {
        if (++g.passesInCb > 64 && g.enc) g.flush(0);
    };
    g.ringDone = 0;
    g.flush = used => {
        g.endPass();
        if (!used && Module.uewRingUsedPtr) used = HEAPU32[Module.uewRingUsedPtr >>> 2 >>> 0];
        used = used + 3 & ~3;
        if (used < g.ringDone) g.ringDone = 0;
        if (used > g.ringDone) g.queue.writeBuffer(g.ring, g.ringDone, HEAPU8, g.ringPtr + g.ringDone, used - g.ringDone);
        g.ringDone = used;
        if (g.enc) {
            g.queue.submit([ g.enc.finish() ]);
            g.enc = null;
        }
        g.passesInCb = 0;
    };
    g.dummy = key => {
        let x = g.dummies.get(key);
        if (x) return x;
        const [dim, type] = key.split(":");
        if (key === "buf" || key === "sbuf") x = device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.STORAGE
        }); else if (key === "stex") x = device.createTexture({
            size: [ 1, 1 ],
            format: "r32float",
            usage: GPUTextureUsage.STORAGE_BINDING
        }).createView(); else {
            const fmt = type === "depth" ? "depth32float" : type === "sint" ? "rgba8sint" : type === "uint" ? "rgba8uint" : "rgba8unorm";
            const layers = dim.startsWith("cube") ? 6 : 1;
            const tdim = dim === "1d" ? "1d" : dim === "3d" ? "3d" : "2d";
            x = device.createTexture({
                size: [ 1, 1, layers ],
                dimension: tdim,
                format: fmt,
                usage: GPUTextureUsage.TEXTURE_BINDING
            }).createView({
                dimension: dim
            });
        }
        g.dummies.set(key, x);
        return x;
    };
    g.emptyLayout = device.createBindGroupLayout({
        entries: []
    });
    g.zeroVB = () => g.zvb || (g.zvb = device.createBuffer({
        size: 65536,
        usage: GPUBufferUsage.VERTEX
    }));
    g.guard = (what, fn) => {
        try {
            fn();
        } catch (e) {
            g.skip.threw++;
            g.skip.last = `${what}: ${e.message} @ ${(e.stack || "").split("\n").slice(1, 3).join(" < ")}`;
            if (g.errors++ < 40) console.log(`[webgpu] ${what}: ${e.message}`);
        }
    };
    g.skip = {
        nopass: 0,
        nopipe: 0,
        threw: 0,
        last: ""
    };
    g.hitch = {
        last: 0,
        tex: 0,
        texPx: 0,
        upBytes: 0,
        sh: 0,
        pipe: 0,
        psh: 0,
        ppipe: 0,
        rb: 0,
        bytes: 0,
        req: 0,
        fms: 0,
        logged: 0
    };
    g.capFrame = (typeof window != "undefined" && window.uewCaptureFrame) | 0;
    g.cap = null;
    g.capEvent = e => {
        if (g.cap && g.cap.events.length < 4e3) g.cap.events.push(e);
    };
    g.capTarget = (att, aspect) => {
        const v = att && att.view, t = v && v.__tex;
        if (!t || g.cap.reads.length >= 400) return null;
        const bpp = {
            rgba8unorm: 4,
            "rgba8unorm-srgb": 4,
            bgra8unorm: 4,
            "bgra8unorm-srgb": 4,
            rgb10a2unorm: 4,
            rg11b10ufloat: 4,
            r32float: 4,
            rg32float: 8,
            rgba32float: 16,
            rgba16float: 8,
            rg16float: 4,
            r16float: 2,
            r8unorm: 1,
            rg8unorm: 2,
            depth32float: 4,
            "depth32float-stencil8": 4
        }[t.format];
        if (!bpp || t.dimension !== "2d") return null;
        const mip = v.__mip || 0, w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip), bpr = w * bpp + 255 & ~255;
        const buf = device.createBuffer({
            size: bpr * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        const src = {
            texture: t,
            mipLevel: mip,
            origin: [ 0, 0, v.__layer || 0 ]
        };
        if (aspect) src.aspect = aspect;
        g.encoder().copyTextureToBuffer(src, {
            buffer: buf,
            bytesPerRow: bpr,
            rowsPerImage: h
        }, [ w, h, 1 ]);
        const r = {
            buf: buf,
            w: w,
            h: h,
            bpr: bpr,
            fmt: t.format,
            tex: t.__id,
            mip: mip,
            layer: v.__layer || 0
        };
        g.cap.reads.push(r);
        return g.cap.reads.length - 1;
    };
    g.pendClears = [];
    g.flushClears = () => {
        for (const d of g.pendClears) {
            const colorAttachments = d.color.filter(c => c).map(c => ({
                view: c.view,
                loadOp: "clear",
                storeOp: "store",
                clearValue: c.clear,
                depthSlice: c.slice >= 0 ? c.slice : undefined
            }));
            let depthStencilAttachment;
            if (d.depth) {
                const z = d.depth;
                depthStencilAttachment = {
                    view: z.view,
                    depthLoadOp: z.dclear !== undefined ? "clear" : "load",
                    depthStoreOp: "store",
                    depthClearValue: z.dclear ?? 1
                };
                if (z.stencil) Object.assign(depthStencilAttachment, {
                    stencilLoadOp: z.sclear !== undefined ? "clear" : "load",
                    stencilStoreOp: "store",
                    stencilClearValue: z.sclear ?? 0
                });
            }
            if (colorAttachments.length || depthStencilAttachment) g.encoder().beginRenderPass({
                colorAttachments: colorAttachments,
                depthStencilAttachment: depthStencilAttachment
            }).end();
        }
        g.pendClears.length = 0;
    };
    g.endPass = keepClears => {
        if (g.pass) {
            g.pass.end();
            g.pass = null;
            if (g.cap && g.cap.cur) {
                const c = g.cap.cur;
                g.cap.cur = null;
                c.reads = c.desc.colorAttachments.map(a => a ? g.capTarget(a) : null);
                if (c.desc.depthStencilAttachment) c.reads.push(g.capTarget(c.desc.depthStencilAttachment, "depth-only"));
                delete c.desc;
                g.capEvent(c);
            }
        }
        if (!keepClears && g.pendClears.length) g.flushClears();
    };
    g.capFinish = async cap => {
        const half = u => {
            const e = u >> 10 & 31, m = u & 1023, s = u & 32768 ? -1 : 1;
            return e === 0 ? s * m * 5.96e-8 : e === 31 ? m ? NaN : s * Infinity : s * (1 + m / 1024) * Math.pow(2, e - 15);
        };
        const uf = (v, mb) => {
            const e = v >> mb, m = v & (1 << mb) - 1;
            return e === 0 ? m / (1 << mb) * Math.pow(2, -14) : e === 31 ? Infinity : (1 + m / (1 << mb)) * Math.pow(2, e - 15);
        };
        const out = [];
        for (const r of cap.reads) {
            await r.buf.mapAsync(GPUMapMode.READ);
            const raw = new Uint8Array(r.buf.getMappedRange().slice(0));
            r.buf.unmap();
            r.buf.destroy();
            const dv = new DataView(raw.buffer), px = new Float32Array(r.w * r.h * 4);
            for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
                const o = y * r.bpr, k = (y * r.w + x) * 4;
                let c = [ 0, 0, 0, 1 ];
                switch (r.fmt) {
                  case "rgba8unorm":
                  case "rgba8unorm-srgb":
                    {
                        const q = o + x * 4;
                        c = [ raw[q] / 255, raw[q + 1] / 255, raw[q + 2] / 255, raw[q + 3] / 255 ];
                        break;
                    }

                  case "bgra8unorm":
                  case "bgra8unorm-srgb":
                    {
                        const q = o + x * 4;
                        c = [ raw[q + 2] / 255, raw[q + 1] / 255, raw[q] / 255, raw[q + 3] / 255 ];
                        break;
                    }

                  case "rgb10a2unorm":
                    {
                        const u = dv.getUint32(o + x * 4, true);
                        c = [ (u & 1023) / 1023, (u >> 10 & 1023) / 1023, (u >> 20 & 1023) / 1023, (u >>> 30) / 3 ];
                        break;
                    }

                  case "rg11b10ufloat":
                    {
                        const u = dv.getUint32(o + x * 4, true);
                        c = [ uf(u & 2047, 6), uf(u >> 11 & 2047, 6), uf(u >>> 22, 5), 1 ];
                        break;
                    }

                  case "r32float":
                  case "depth32float":
                  case "depth32float-stencil8":
                    {
                        const f = dv.getFloat32(o + x * 4, true);
                        c = [ f, f, f, 1 ];
                        break;
                    }

                  case "rg32float":
                    c = [ dv.getFloat32(o + x * 8, true), dv.getFloat32(o + x * 8 + 4, true), 0, 1 ];
                    break;

                  case "rgba32float":
                    for (let j = 0; j < 4; j++) c[j] = dv.getFloat32(o + x * 16 + j * 4, true);
                    break;

                  case "rgba16float":
                    for (let j = 0; j < 4; j++) c[j] = half(dv.getUint16(o + x * 8 + j * 2, true));
                    break;

                  case "rg16float":
                    c = [ half(dv.getUint16(o + x * 4, true)), half(dv.getUint16(o + x * 4 + 2, true)), 0, 1 ];
                    break;

                  case "r16float":
                    {
                        const f = half(dv.getUint16(o + x * 2, true));
                        c = [ f, f, f, 1 ];
                        break;
                    }

                  case "r8unorm":
                    {
                        const f = raw[o + x] / 255;
                        c = [ f, f, f, 1 ];
                        break;
                    }

                  case "rg8unorm":
                    c = [ raw[o + x * 2] / 255, raw[o + x * 2 + 1] / 255, 0, 1 ];
                    break;
                }
                px.set(c, k);
            }
            const mn = [ Infinity, Infinity, Infinity, Infinity ], mx = [ -Infinity, -Infinity, -Infinity, -Infinity ], sum = [ 0, 0, 0, 0 ];
            let bad = 0, neg = 0, huge = 0;
            const mask = new Uint8Array(r.w * r.h);
            for (let i = 0; i < px.length; i++) {
                const v = px[i], j = i & 3;
                if (!isFinite(v)) {
                    bad++;
                    mask[i >> 2] = 3;
                    continue;
                }
                if (v < mn[j]) mn[j] = v;
                if (v > mx[j]) mx[j] = v;
                sum[j] += v;
                if (j < 3 && v < 0) {
                    neg++;
                    mask[i >> 2] |= 1;
                }
                if (j < 3 && v > 1e3) {
                    huge++;
                    mask[i >> 2] |= 2;
                }
            }
            let maskPng = null;
            if (neg || huge || bad) {
                const mc = document.createElement("canvas");
                mc.width = r.w;
                mc.height = r.h;
                const m2 = mc.getContext("2d"), mi = m2.createImageData(r.w, r.h);
                for (let i = 0; i < r.w * r.h; i++) {
                    mi.data[i * 4] = mask[i] & 2 ? 255 : 0;
                    mi.data[i * 4 + 2] = mask[i] & 1 ? 255 : 0;
                    mi.data[i * 4 + 1] = mask[i] === 3 ? 255 : 0;
                    mi.data[i * 4 + 3] = 255;
                }
                m2.putImageData(mi, 0, 0);
                maskPng = mc.toDataURL("image/png");
            }
            const depth = r.fmt.startsWith("depth");
            const cv = document.createElement("canvas");
            cv.width = r.w;
            cv.height = r.h;
            const c2 = cv.getContext("2d"), img = c2.createImageData(r.w, r.h);
            for (let i = 0; i < r.w * r.h; i++) for (let j = 0; j < 4; j++) {
                let v = px[i * 4 + j];
                if (!isFinite(v)) v = j === 0 ? 1 : 0; else if (j < 3) v = depth ? (v - mn[0]) / Math.max(1e-9, mx[0] - mn[0]) : v / (1 + Math.max(0, v - 1));
                img.data[i * 4 + j] = j === 3 ? 255 : Math.max(0, Math.min(255, v * 255));
            }
            c2.putImageData(img, 0, 0);
            const n = r.w * r.h;
            let hdrPng = null;
            if (/float/.test(r.fmt) && !depth) {
                const lum = (sum[0] + sum[1] + sum[2]) / (3 * n), k = lum > 0 ? .18 / lum : 1;
                const img2 = c2.createImageData(r.w, r.h);
                for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) {
                    let v = px[i * 4 + j] * (j < 3 ? k : 1);
                    if (!isFinite(v)) v = 0;
                    if (j < 3) v = Math.pow(v / (1 + v), 1 / 2.2);
                    img2.data[i * 4 + j] = j === 3 ? 255 : Math.max(0, Math.min(255, v * 255));
                }
                const cv2 = document.createElement("canvas");
                cv2.width = r.w;
                cv2.height = r.h;
                cv2.getContext("2d").putImageData(img2, 0, 0);
                hdrPng = cv2.toDataURL("image/png");
            }
            out.push({
                fmt: r.fmt,
                w: r.w,
                h: r.h,
                tex: r.tex,
                mip: r.mip,
                layer: r.layer,
                min: mn,
                max: mx,
                mean: sum.map(s => s / n),
                nonfinite: bad,
                neg: neg,
                huge: huge,
                mask: maskPng,
                hdr: hdrPng,
                png: cv.toDataURL("image/png")
            });
        }
        const raw = {};
        let want = window.uewCaptureTex || [];
        if (want === "auto") {
            want = new Set;
            for (const e of cap.events) if (e.draws && e.draws.length >= 20) for (const r of (e.draws[0].res[3] || []).slice(0, 4)) if (typeof r === "number") want.add(r);
            for (const e of cap.events) for (const d of e.draws || []) for (const grp of d.res || []) for (const r of grp || []) if (typeof r === "number" && g.o[r] instanceof GPUTexture && g.o[r].depthOrArrayLayers === 6) want.add(r);
        }
        const items = [];
        for (const id of want) {
            const t = g.o[id];
            if (!(t instanceof GPUTexture)) continue;
            const mips = t.depthOrArrayLayers === 6 ? t.mipLevelCount : 1;
            for (let m = 0; m < mips; m++) items.push([ id, m ]);
        }
        for (const [id, mip] of items) {
            const t = g.o[id];
            if (!(t instanceof GPUTexture) || t.dimension !== "2d") continue;
            const bc = /^bc/.test(t.format), blk = bc ? /^bc[14]/.test(t.format) ? 8 : 16 : 0;
            const bpp = {
                rgba8unorm: 4,
                "rgba8unorm-srgb": 4,
                bgra8unorm: 4,
                rgba16float: 8,
                r8unorm: 1,
                rg8unorm: 2,
                r16float: 2,
                rgba32float: 16
            }[t.format];
            if (!bc && !bpp) {
                raw[id] = {
                    fmt: t.format
                };
                continue;
            }
            const tw = Math.max(1, t.width >> mip), th = Math.max(1, t.height >> mip);
            const bw = bc ? tw + 3 >> 2 : tw, bh = bc ? th + 3 >> 2 : th, rowb = bw * (bc ? blk : bpp), bpr = rowb + 255 & ~255;
            const L = Math.min(t.depthOrArrayLayers, 6);
            const buf = device.createBuffer({
                size: bpr * bh * L,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            });
            const e = device.createCommandEncoder();
            e.copyTextureToBuffer({
                texture: t,
                mipLevel: mip
            }, {
                buffer: buf,
                bytesPerRow: bpr,
                rowsPerImage: bh
            }, [ bc ? bw * 4 : tw, bc ? bh * 4 : th, L ]);
            g.queue.submit([ e.finish() ]);
            await buf.mapAsync(GPUMapMode.READ);
            const src = new Uint8Array(buf.getMappedRange()), dst = new Uint8Array(rowb * bh * L);
            for (let y = 0; y < bh * L; y++) dst.set(src.subarray(y * bpr, y * bpr + rowb), y * rowb);
            buf.unmap();
            buf.destroy();
            let bin = "";
            for (let i = 0; i < dst.length; i += 32768) bin += String.fromCharCode.apply(null, dst.subarray(i, i + 32768));
            raw[mip ? `${id}m${mip}` : id] = {
                fmt: t.format,
                w: tw,
                h: th * L,
                data: btoa(bin)
            };
        }
        const perDraw = [];
        for (const r of cap.perDraw) {
            await r.buf.mapAsync(GPUMapMode.READ);
            const u = new Uint16Array(r.buf.getMappedRange());
            let neg = 0, huge = 0;
            for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w * 4; x++) {
                if ((x & 3) === 3) continue;
                const v = u[(y * r.bpr >> 1) + x];
                if (v & 32768 && v & 32767) neg++; else if ((v & 32767) > 25552) huge++;
            }
            r.buf.unmap();
            r.buf.destroy();
            perDraw.push({
                pass: r.pass,
                draw: r.draw,
                ps: r.ps,
                tex: r.tex,
                neg: neg,
                huge: huge
            });
        }
        const px = [];
        for (const r of cap.px) {
            await r.buf.mapAsync(GPUMapMode.READ);
            const dv = new DataView(r.buf.getMappedRange());
            const h2f = u => {
                const e = u >> 10 & 31, m = u & 1023, sg = u & 32768 ? -1 : 1;
                return e === 0 ? sg * m * 5.96e-8 : e === 31 ? NaN : sg * (1 + m / 1024) * Math.pow(2, e - 15);
            };
            for (const [x, y] of window.uewCapturePixels) {
                if (x >= r.w || y >= r.h) continue;
                const o = y * r.bpr + x * r.bpp;
                const val = r.kind === "z" ? [ dv.getFloat32(o, true) ] : [ 0, 2, 4, 6 ].map(k => +h2f(dv.getUint16(o + k, true)).toPrecision(5));
                px.push({
                    kind: r.kind,
                    x: x,
                    y: y,
                    pass: r.pass,
                    draw: r.draw,
                    ps: r.ps,
                    vs: r.vs,
                    n: r.n,
                    first: r.first,
                    val: val
                });
            }
            r.buf.unmap();
            r.buf.destroy();
        }
        Module.uewgCaptured = {
            events: cap.events,
            images: out,
            shaders: g.capShaders,
            raw: raw,
            perDraw: perDraw,
            px: px
        };
        console.log(`[webgpu] captured frame ${g.frames}: ${cap.events.length} events, ${out.length} targets`);
    };
    g.capShaders = {};
    g.stat = {
        pass: 0,
        reopen: 0,
        write: 0,
        writeBytes: 0,
        ringCopy: 0,
        texWrite: 0,
        bg: 0,
        draws: 0
    };
    g.openPass = () => {
        g.stat.pass++;
        g.pass = g.encoder().beginRenderPass(g.lastPass);
        if (g.cap) g.cap.cur = {
            pass: g.cap.events.length,
            desc: g.lastPass,
            draws: []
        };
    };
    const ai = adapter.info || {};
    console.log(`[webgpu] GPU: ${[ ai.vendor, ai.architecture, ai.description ].filter(x => x).join(" / ") || "not reported"}${ai.isFallbackAdapter ? " (software fallback!)" : ""}; features: ${features.join(" ")}`);
    if (/intel|integrated/i.test(`${ai.vendor} ${ai.architecture} ${ai.description}`)) console.log("[webgpu] this may be the integrated GPU: Windows Settings > System > Display > Graphics, set your browser to High performance");
    return 1 | (g.features.has("depth32float-stencil8") ? 2 : 0);
}

_uewg_init.isAsync = true;

var _uewg_layout_create = function(jsonPtr) {
    const g = Module.uewg;
    const groups = JSON.parse(UTF8ToString(jsonPtr >>> 0));
    const bgls = groups.map(entries => entries.length ? g.device.createBindGroupLayout({
        entries: entries
    }) : g.emptyLayout);
    return g.add({
        pl: g.device.createPipelineLayout({
            bindGroupLayouts: bgls
        }),
        bgls: bgls
    });
};

function _uewg_max_dynamic_ubo() {
    return Module.uewg.device.limits.maxDynamicUniformBuffersPerPipelineLayout;
}

function _uewg_max_storage() {
    return Module.uewg.device.limits.maxStorageBuffersPerShaderStage;
}

function _uewg_pipe_ready(id) {
    const g = Module.uewg;
    return g.skipPending || !g.pending.has(id) ? 1 : 0;
}

function _uewg_present(view, ringUsed) {
    const g = Module.uewg;
    Module.uewPresents = (Module.uewPresents || 0) + 1;
    if (g.prof) g.prof.frameEnd();
    const now = performance.now(), h = g.hitch, F = Module.uewFiles || {};
    if (h.last && now - h.last > 100 && g.frames > 60 && h.logged < 300) {
        h.logged++;
        console.log(`[hitch] ${(now - h.last).toFixed(0)} ms frame: ${h.sh + h.psh} new shaders, ${h.pipe + h.ppipe} new pipelines (this frame and the one before), ${h.rb} GPU readbacks, ` + `${(((F.fetched || 0) - h.bytes) / 1048576).toFixed(1)} MB in ${(F.requests || 0) - h.req} downloads (${((F.fetchMs || 0) - h.fms).toFixed(0)} ms waiting)`);
    }
    h.last = now;
    h.psh = h.sh;
    h.ppipe = h.pipe;
    h.sh = 0;
    h.pipe = 0;
    h.rb = 0;
    h.bytes = F.fetched || 0;
    h.req = F.requests || 0;
    h.fms = F.fetchMs || 0;
    g.endPass();
    if (!g.blit) {
        const code = `@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;\n        struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };\n        @vertex fn vs(@builtin(vertex_index) i: u32) -> V { let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)); var o: V; o.p = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0); o.uv = uv; return o; }\n        @fragment fn fs(v: V) -> @location(0) vec4<f32> { return vec4<f32>(textureSampleLevel(t, s, v.uv, 0.0).rgb, 1.0); }`;
        const m = g.device.createShaderModule({
            code: code
        });
        g.blit = g.device.createRenderPipeline({
            layout: "auto",
            vertex: {
                module: m,
                entryPoint: "vs"
            },
            fragment: {
                module: m,
                entryPoint: "fs",
                targets: [ {
                    format: g.canvasFormat
                } ]
            },
            primitive: {
                topology: "triangle-list"
            }
        });
        g.blitSampler = g.device.createSampler({
            magFilter: "linear",
            minFilter: "linear"
        });
        g.blitGroups = new Map;
    }
    const src = g.o[view];
    if (g.cap) g.capEvent({
        present: view,
        tex: src && src.__tex && src.__tex.__id
    });
    if (src) {
        let bg = g.blitGroups.get(src);
        if (!bg) {
            bg = g.device.createBindGroup({
                layout: g.blit.getBindGroupLayout(0),
                entries: [ {
                    binding: 0,
                    resource: src
                }, {
                    binding: 1,
                    resource: g.blitSampler
                } ]
            });
            g.blitGroups.set(src, bg);
        }
        const p = g.encoder().beginRenderPass({
            colorAttachments: [ {
                view: g.ctx.getCurrentTexture().createView(),
                loadOp: "clear",
                storeOp: "store",
                clearValue: [ 0, 0, 0, 1 ]
            } ]
        });
        p.setPipeline(g.blit);
        p.setBindGroup(0, bg);
        p.draw(3);
        p.end();
    }
    g.flush(ringUsed);
    if (g.expandTmp && g.expandTmp.length) {
        const tmp = g.expandTmp;
        g.expandTmp = [];
        g.queue.onSubmittedWorkDone().then(() => tmp.forEach(b => b.destroy()));
    }
    g.lastPass = null;
    {
        const h = g.hitch, t0 = performance.now(), info = `${h.tex} textures made (${(h.texPx / 1e6).toFixed(1)} Mpx), ${(h.upBytes / 1048576).toFixed(1)} MB uploaded`;
        h.tex = 0;
        h.texPx = 0;
        h.upBytes = 0;
        g.queue.onSubmittedWorkDone().then(() => {
            const ms = performance.now() - t0;
            if (ms > 150 && (h.gpuLogged = (h.gpuLogged || 0) + 1) < 100) console.log(`[hitch] GPU took ${ms.toFixed(0)} ms for a frame: ${info}`);
        });
    }
    g.frames++;
    if (g.capFrame && window.uewCaptureFrame) g.capFrame = window.uewCaptureFrame | 0;
    if (g.cap && g.frames === g.capFrame) {
        const c = g.cap;
        g.cap = null;
        g.capFinish(c);
    }
    if (g.capFrame && g.frames === g.capFrame - 1) g.cap = {
        events: [],
        reads: [],
        cur: null,
        perDraw: [],
        px: []
    };
    if (g.frames === 1 || g.frames % 600 === 0) {
        const s = g.skip;
        console.log(`[webgpu] frame ${g.frames} (${g.draws} draws so far; skipped: ${s.nopass} no pass, ${s.nopipe} no pipeline, ${s.threw} threw${s.last ? " — " + s.last : ""})`);
        g.skip = {
            nopass: 0,
            nopipe: 0,
            threw: 0,
            last: ""
        };
        const top = [ ...g.errKinds ].sort((a, b) => b[1] - a[1]).slice(0, 6);
        for (const [k, n] of top) console.log(`[webgpu]   ${n} x ${k}`);
        g.errKinds.clear();
        const st = g.stat, f = g.frames === 1 ? 1 : 600;
        if (Module.uewgStats || typeof window != "undefined" && window.uewStats) if (st.by) console.log("[webgpu] biggest writers (id: bytes/frame, buffer size, last offset): " + [ ...st.by ].sort((a, b) => b[1][0] - a[1][0]).slice(0, 5).map(([k, v]) => `${k}: ${(v[0] / f / 1024).toFixed(0)} KiB of ${(v[1] / 1024).toFixed(0)} KiB @${v[2]}`).join(", "));
        console.log(`[webgpu] per frame: ${(st.pass / f).toFixed(1)} passes (${(st.reopen / f).toFixed(1)} reopened), ${(st.write / f).toFixed(1)} buffer writes (${(st.writeBytes / f / 1024).toFixed(0)} KiB), ${(st.ringCopy / f).toFixed(1)} ring copies, ${(st.texWrite / f).toFixed(1)} texture uploads, ${(st.bg / f).toFixed(1)} bind groups made, ${(st.draws / f).toFixed(0)} draws`);
        g.stat = {
            pass: 0,
            reopen: 0,
            write: 0,
            writeBytes: 0,
            ringCopy: 0,
            texWrite: 0,
            bg: 0,
            draws: 0,
            by: Module.uewgStats || typeof window != "undefined" && window.uewStats ? new Map : null
        };
    }
}

function _uewg_readback_done(n) {
    const t = Module.uewg.rb && Module.uewg.rb.get(n);
    return !t || t.done ? 1 : 0;
}

function _uewg_readback_finish(n) {
    const g = Module.uewg, t = g.rb && g.rb.get(n);
    if (!t) return;
    g.rb.delete(n);
    if (t.ok) {
        const data = new Uint8Array(t.tmp.getMappedRange());
        if (!t.kind) HEAPU8.set(data.subarray(0, t.w), t.ptr >>> 0); else for (let z = 0; z < t.d; z++) for (let y = 0; y < t.rows; y++) HEAPU8.set(data.subarray((z * t.rows + y) * t.bpr, (z * t.rows + y) * t.bpr + Math.min(t.rowbytes, t.pitch)), t.ptr + z * t.slice + y * t.pitch >>> 0);
        t.tmp.unmap();
    }
    t.tmp.destroy();
}

function _uewg_readback_latest(kind, id, mip, layer, w, h, d, ptr, pitch, slice, rowbytes, rows) {
    const g = Module.uewg, src = g.o[id];
    if (!src || typeof location !== "undefined" && /[?&]syncreadback=1/.test(location.search)) return 0;
    g.rbl = g.rbl || new Map;
    const k = id + ":" + mip + ":" + layer;
    let e = g.rbl.get(k);
    if (!e) {
        e = {
            busy: false,
            data: null
        };
        g.rbl.set(k, e);
    }
    let got = 0;
    if (e.data) {
        ptr >>>= 0;
        const bpr = kind ? rowbytes + 255 & ~255 : 0;
        if (!kind) HEAPU8.set(e.data.subarray(0, w), ptr >>> 0); else for (let z = 0; z < d; z++) for (let y = 0; y < rows; y++) HEAPU8.set(e.data.subarray((z * rows + y) * bpr, (z * rows + y) * bpr + Math.min(rowbytes, pitch)), ptr + z * slice + y * pitch >>> 0);
        got = 1;
    }
    if (!e.busy) {
        g.flush(0);
        const bpr = kind ? rowbytes + 255 & ~255 : 0, size = kind ? bpr * rows * d : w + 3 & ~3;
        const tmp = g.device.createBuffer({
            size: Math.max(4, size),
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        const enc = g.device.createCommandEncoder();
        try {
            if (kind) enc.copyTextureToBuffer({
                texture: src,
                mipLevel: mip,
                origin: [ 0, 0, layer ]
            }, {
                buffer: tmp,
                bytesPerRow: bpr,
                rowsPerImage: rows
            }, [ w, h, d ]); else enc.copyBufferToBuffer(src, 0, tmp, 0, Math.min(size, src.size));
            g.queue.submit([ enc.finish() ]);
        } catch (err) {
            tmp.destroy();
            return got;
        }
        e.busy = true;
        tmp.mapAsync(GPUMapMode.READ).then(() => {
            e.data = new Uint8Array(tmp.getMappedRange()).slice();
            tmp.unmap();
            tmp.destroy();
            e.busy = false;
        }, () => {
            tmp.destroy();
            e.busy = false;
        });
    }
    return got;
}

function _uewg_readback_start(kind, id, mip, layer, w, h, d, ptr, pitch, slice, rowbytes, rows) {
    const g = Module.uewg, src = g.o[id];
    if (!src) return 0;
    g.flush(0);
    const bpr = kind ? rowbytes + 255 & ~255 : 0, size = kind ? bpr * rows * d : w + 3 & ~3;
    const tmp = g.device.createBuffer({
        size: Math.max(4, size),
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const enc = g.device.createCommandEncoder();
    try {
        if (kind) enc.copyTextureToBuffer({
            texture: src,
            mipLevel: mip,
            origin: [ 0, 0, layer ]
        }, {
            buffer: tmp,
            bytesPerRow: bpr,
            rowsPerImage: rows
        }, [ w, h, d ]); else enc.copyBufferToBuffer(src, 0, tmp, 0, Math.min(size, src.size));
        g.queue.submit([ enc.finish() ]);
    } catch (e) {
        if (g.errors++ < 40) console.log("[webgpu] readback " + e.message);
        tmp.destroy();
        return 0;
    }
    g.hitch.rb++;
    const t = {
        kind: kind,
        w: w,
        d: d,
        rows: rows,
        bpr: bpr,
        rowbytes: rowbytes,
        ptr: ptr >>> 0,
        pitch: pitch,
        slice: slice,
        tmp: tmp,
        done: false,
        ok: false
    };
    const t0 = performance.now();
    tmp.mapAsync(GPUMapMode.READ).then(() => {
        t.ok = true;
        t.done = true;
        Module.uewWake && Module.uewWake();
        const ms = performance.now() - t0;
        if (ms > 50 && (g.rbSlow = (g.rbSlow || 0) + 1) < 60) console.log(`[readback] ${kind ? "texture" : "buffer"} ${w}x${h}x${d} (${size} bytes, ${src.format || ""}) took ${ms.toFixed(0)} ms`);
    }, e => {
        if (g.errors++ < 40) console.log("[webgpu] readback " + e.message);
        t.done = true;
    });
    g.rb = g.rb || new Map;
    g.rbN = (g.rbN || 0) + 1;
    g.rb.set(g.rbN, t);
    return g.rbN;
}

function _uewg_release(id) {
    const g = Module.uewg, x = g.o[id];
    if (!x) return;
    if (x instanceof GPUBuffer || x instanceof GPUTexture) x.destroy();
    g.o[id] = null;
    if (g.pst) g.pst.pass = null;
    g.free.push(id);
}

function _uewg_render_pipeline_create(jsonPtr) {
    const g = Module.uewg;
    const d = JSON.parse(UTF8ToString(jsonPtr >>> 0));
    if (Module.uewgDebug) console.log("[webgpu] pipeline " + UTF8ToString(jsonPtr >>> 0));
    g.hitch.pipe++;
    if (window.uewLogCreates) console.log(`[create] pipeline vs ${d.vs} ps ${d.ps}`);
    const desc = {
        layout: g.o[d.layout].pl,
        vertex: {
            module: g.o[d.vs],
            entryPoint: "main",
            buffers: d.buffers
        },
        fragment: d.ps ? {
            module: g.o[d.ps],
            entryPoint: "main",
            targets: d.targets
        } : undefined,
        primitive: d.primitive,
        depthStencil: d.depth,
        multisample: {
            mask: d.sampleMask >>> 0
        }
    };
    const done = p => {
        if (g.capFrame) p.__d = d;
        p.__vs = d.vs;
        p.__ps = d.ps;
        return p;
    };
    if (g.asyncShaders()) {
        const id = g.add(null);
        g.pendingPipes++;
        g.pending.add(id);
        g.device.createRenderPipelineAsync(desc).then(p => {
            g.o[id] = done(p);
            g.pendingPipes--;
            g.pending.delete(id);
            Module.uewWake && Module.uewWake();
        }, e => {
            g.pendingPipes--;
            g.pending.delete(id);
            Module.uewWake && Module.uewWake();
            if (g.errors++ < 40) console.log("[webgpu] pipeline " + e.message);
        });
        return id;
    }
    try {
        return g.add(done(g.device.createRenderPipeline(desc)));
    } catch (e) {
        if (g.errors++ < 40) console.log("[webgpu] pipeline " + e.message);
        return 0;
    }
}

function _uewg_retire(id) {
    const g = Module.uewg, x = g.o[id];
    if (!x) return;
    if (x instanceof GPUBuffer || x instanceof GPUTexture) x.destroy();
    g.o[id] = null;
    if (g.pst) g.pst.pass = null;
    if (g.rbl && g.rbl.size) for (const k of g.rbl.keys()) if (k.startsWith(id + ":")) g.rbl.delete(k);
}

function _uewg_ring_reset() {
    Module.uewg.ringDone = 0;
}

function _uewg_ring_used_at(p) {
    Module.uewRingUsedPtr = p >>> 0;
}

function _uewg_sampler_create(jsonPtr) {
    const g = Module.uewg;
    return g.add(g.device.createSampler(JSON.parse(UTF8ToString(jsonPtr >>> 0))));
}

function _uewg_shader_create(srcPtr) {
    const g = Module.uewg;
    let code = UTF8ToString(srcPtr >>> 0);
    if (window.uewShaderPatch) code = window.uewShaderPatch(code) || code;
    g.hitch.sh++;
    if (window.uewLogCreates) console.log(`[create] shader ${code.length} chars`);
    const m = g.device.createShaderModule({
        code: code
    });
    if (Module.uewgDebug) console.log("[webgpu] shader " + code);
    m.getCompilationInfo().then(info => {
        for (const x of info.messages) if (x.type === "error" && g.errors++ < 40) console.log(`[webgpu] shader ${x.lineNum}:${x.linePos} ${x.message}`);
    });
    const id = g.add(m);
    if (g.capFrame) g.capShaders[id] = code;
    if (g.prof) g.prof.shaders.set(id, code);
    return id;
}

function _uewg_submit(ringUsed) {
    Module.uewg.flush(ringUsed);
}

function _uewg_texture_copy_ring(ringOff, id, mip, x, y, z, w, h, d, bpr, rows) {
    const g = Module.uewg, t = g.o[id];
    if (!t) return;
    if (/^(bc|etc2|eac|astc)/.test(t.format)) {
        w = w + 3 & ~3;
        h = h + 3 & ~3;
    }
    g.endPass();
    g.stat.texWrite++;
    try {
        g.encoder().copyBufferToTexture({
            buffer: g.ring,
            offset: ringOff,
            bytesPerRow: bpr,
            rowsPerImage: rows
        }, {
            texture: t,
            mipLevel: mip,
            origin: [ x, y, z ]
        }, [ w, h, d ]);
    } catch (e) {
        if (g.errors++ < 40) console.log("[webgpu] ring upload " + e.message);
    }
}

function _uewg_texture_create(jsonPtr) {
    const g = Module.uewg;
    const d = JSON.parse(UTF8ToString(jsonPtr >>> 0));
    let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
    if (d.rt) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
    if (d.uav) usage |= GPUTextureUsage.STORAGE_BINDING;
    try {
        const t = g.device.createTexture({
            size: [ d.w, d.h, d.d ],
            mipLevelCount: d.mips,
            format: d.format,
            dimension: d.dim,
            usage: usage,
            viewFormats: d.viewFormats || []
        });
        g.hitch.tex++;
        g.hitch.texPx += d.w * d.h * d.d;
        const id = g.add(t);
        if (g.capFrame) t.__id = id;
        return id;
    } catch (e) {
        console.log("[webgpu] texture " + d.format + ": " + e.message);
        return 0;
    }
}

function _uewg_texture_write(id, mip, x, y, z, w, h, d, ptr, bpr, rows, size) {
    ptr >>>= 0;
    const g = Module.uewg, t = g.o[id];
    if (!t) return;
    if (/^(bc|etc2|eac|astc)/.test(t.format)) {
        w = w + 3 & ~3;
        h = h + 3 & ~3;
    }
    g.stat.texWrite++;
    g.hitch.upBytes += bpr * rows * d;
    try {
        g.queue.writeTexture({
            texture: t,
            mipLevel: mip,
            origin: [ x, y, z ]
        }, HEAPU8, {
            offset: ptr,
            bytesPerRow: bpr,
            rowsPerImage: rows
        }, [ w, h, d ]);
    } catch (e) {
        if (g.errors++ < 40) console.log("[webgpu] upload " + e.message);
    }
}

var _uewg_timestamp = function() {
    const g = Module.uewg;
    const t = g.tsNext = (g.tsNext || 0) + 1;
    (g.ts || (g.ts = new Map)).set(t, -1);
    g.queue.onSubmittedWorkDone().then(() => {
        g.ts.set(t, performance.now());
        Module.uewWake && Module.uewWake();
    }, () => g.ts.set(t, performance.now()));
    if (g.ts.size > 4096) for (const k of g.ts.keys()) {
        if (g.ts.size <= 2048) break;
        g.ts.delete(k);
    }
    return t;
};

var HEAPF64;

function _uewg_timestamp_get(t, out) {
    const g = Module.uewg, v = g.ts ? g.ts.get(t) : undefined;
    if (v === undefined) {
        HEAPF64[out >>> 3 >>> 0] = performance.now();
        return 1;
    }
    if (v < 0) return 0;
    HEAPF64[out >>> 3 >>> 0] = v;
    return 1;
}

function _uewg_view_create(jsonPtr) {
    const g = Module.uewg;
    const d = JSON.parse(UTF8ToString(jsonPtr >>> 0));
    const t = g.o[d.tex];
    if (!t) return 0;
    const desc = {
        dimension: d.dim,
        baseMipLevel: d.mip,
        mipLevelCount: d.mips,
        baseArrayLayer: d.layer,
        arrayLayerCount: d.layers,
        aspect: d.aspect
    };
    if (d.format) desc.format = d.format;
    if (d.swizzle && g.features.has("texture-component-swizzle")) desc.swizzle = d.swizzle;
    try {
        const v = t.createView(desc);
        if (g.capFrame) {
            v.__tex = t;
            v.__mip = d.mip;
            v.__layer = d.layer;
        }
        return g.add(v);
    } catch (e) {
        if (g.errors++ < 40) console.log("[webgpu] view " + e.message);
        return 0;
    }
}

var handleException = e => {
    if (e instanceof ExitStatus || e == "unwind") {
        return EXITSTATUS;
    }
    quit_(1, e);
};

var stackAlloc = sz => __emscripten_stack_alloc(sz);

var stringToUTF8OnStack = str => {
    var size = lengthBytesUTF8(str) + 1;
    var ret = stackAlloc(size);
    stringToUTF8(str, ret, size);
    return ret;
};

var stringToNewUTF8 = str => {
    var size = lengthBytesUTF8(str) + 1;
    var ret = _malloc(size);
    if (ret) stringToUTF8(str, ret, size);
    return ret;
};

var runtimeKeepalivePop = () => {
    runtimeKeepaliveCounter -= 1;
};

var runtimeKeepalivePush = () => {
    runtimeKeepaliveCounter += 1;
};

var Asyncify = {
    instrumentWasmImports(imports) {
        var importPattern = /^(invoke_.*|__asyncjs__.*)$/;
        for (let [x, original] of Object.entries(imports)) {
            if (typeof original === "function") {
                let isAsyncifyImport = original.isAsync || importPattern.test(x);
                if (isAsyncifyImport) {
                    imports[x] = original = new WebAssembly.Suspending(original);
                }
            }
        }
    },
    instrumentWasmExports(exports) {
        var exportPattern = /^(uew_ctx_start|main|__main_argc_argv)$/;
        Asyncify.asyncExports = new Set;
        var ret = {};
        for (let [x, original] of Object.entries(exports)) {
            if (typeof original === "function") {
                let isAsyncifyExport = exportPattern.test(x);
                if (isAsyncifyExport) {
                    Asyncify.asyncExports.add(original);
                    original = Asyncify.makeAsyncFunction(original);
                }
                ret[x] = original;
            } else {
                ret[x] = original;
            }
        }
        return ret;
    },
    asyncExports: null,
    isAsyncExport(func) {
        return Asyncify.asyncExports?.has(func);
    },
    handleAsync: async startAsync => {
        runtimeKeepalivePush();
        try {
            return await startAsync();
        } finally {
            runtimeKeepalivePop();
        }
    },
    handleSleep: startAsync => Asyncify.handleAsync(() => new Promise(startAsync)),
    makeAsyncFunction(original) {
        return WebAssembly.promising(original);
    }
};

var FS_createPath = (...args) => FS.createPath(...args);

var FS_unlink = (...args) => FS.unlink(...args);

var FS_createLazyFile = (...args) => FS.createLazyFile(...args);

var FS_createDevice = (...args) => FS.createDevice(...args);

var syscallGetVarargP = syscallGetVarargI;

var findCanvasEventTarget = findEventTarget;

var _emscripten_webgl_create_context = __emscripten_webgl_do_create_context;

var _exit = exitJS;

var _glActiveTexture = _emscripten_glActiveTexture;

var _glAttachShader = _emscripten_glAttachShader;

var _glBindBuffer = _emscripten_glBindBuffer;

var _glBindBufferRange = _emscripten_glBindBufferRange;

var _glBindFramebuffer = _emscripten_glBindFramebuffer;

var _glBindSampler = _emscripten_glBindSampler;

var _glBindTexture = _emscripten_glBindTexture;

var _glBindVertexArray = _emscripten_glBindVertexArray;

var _glBlendColor = _emscripten_glBlendColor;

var _glBlendEquationSeparate = _emscripten_glBlendEquationSeparate;

var _glBlendFuncSeparate = _emscripten_glBlendFuncSeparate;

var _glBlitFramebuffer = _emscripten_glBlitFramebuffer;

var _glBufferData = _emscripten_glBufferData;

var _glBufferSubData = _emscripten_glBufferSubData;

var _glClearBufferfi = _emscripten_glClearBufferfi;

var _glClearBufferfv = _emscripten_glClearBufferfv;

var _glClearBufferiv = _emscripten_glClearBufferiv;

var _glClearBufferuiv = _emscripten_glClearBufferuiv;

var _glColorMask = _emscripten_glColorMask;

var _glCompileShader = _emscripten_glCompileShader;

var _glCompressedTexSubImage2D = _emscripten_glCompressedTexSubImage2D;

var _glCompressedTexSubImage3D = _emscripten_glCompressedTexSubImage3D;

var _glCopyBufferSubData = _emscripten_glCopyBufferSubData;

var _glCopyTexSubImage2D = _emscripten_glCopyTexSubImage2D;

var _glCopyTexSubImage3D = _emscripten_glCopyTexSubImage3D;

var _glCreateProgram = _emscripten_glCreateProgram;

var _glCreateShader = _emscripten_glCreateShader;

var _glCullFace = _emscripten_glCullFace;

var _glDeleteFramebuffers = _emscripten_glDeleteFramebuffers;

var _glDeleteProgram = _emscripten_glDeleteProgram;

var _glDeleteShader = _emscripten_glDeleteShader;

var _glDepthFunc = _emscripten_glDepthFunc;

var _glDepthMask = _emscripten_glDepthMask;

var _glDepthRangef = _emscripten_glDepthRangef;

var _glDisable = _emscripten_glDisable;

var _glDisableVertexAttribArray = _emscripten_glDisableVertexAttribArray;

var _glDrawArrays = _emscripten_glDrawArrays;

var _glDrawArraysInstanced = _emscripten_glDrawArraysInstanced;

var _glDrawBuffers = _emscripten_glDrawBuffers;

var _glDrawElements = _emscripten_glDrawElements;

var _glDrawElementsInstanced = _emscripten_glDrawElementsInstanced;

var _glEnable = _emscripten_glEnable;

var _glEnableVertexAttribArray = _emscripten_glEnableVertexAttribArray;

var _glFramebufferTexture2D = _emscripten_glFramebufferTexture2D;

var _glFramebufferTextureLayer = _emscripten_glFramebufferTextureLayer;

var _glFrontFace = _emscripten_glFrontFace;

var _glGenBuffers = _emscripten_glGenBuffers;

var _glGenFramebuffers = _emscripten_glGenFramebuffers;

var _glGenSamplers = _emscripten_glGenSamplers;

var _glGenTextures = _emscripten_glGenTextures;

var _glGenVertexArrays = _emscripten_glGenVertexArrays;

var _glGetProgramInfoLog = _emscripten_glGetProgramInfoLog;

var _glGetProgramiv = _emscripten_glGetProgramiv;

var _glGetShaderInfoLog = _emscripten_glGetShaderInfoLog;

var _glGetShaderiv = _emscripten_glGetShaderiv;

var _glGetUniformBlockIndex = _emscripten_glGetUniformBlockIndex;

var _glGetUniformLocation = _emscripten_glGetUniformLocation;

var _glLinkProgram = _emscripten_glLinkProgram;

var _glPixelStorei = _emscripten_glPixelStorei;

var _glPolygonOffset = _emscripten_glPolygonOffset;

var _glSamplerParameterf = _emscripten_glSamplerParameterf;

var _glSamplerParameteri = _emscripten_glSamplerParameteri;

var _glScissor = _emscripten_glScissor;

var _glShaderSource = _emscripten_glShaderSource;

var _glStencilFuncSeparate = _emscripten_glStencilFuncSeparate;

var _glStencilMask = _emscripten_glStencilMask;

var _glStencilOpSeparate = _emscripten_glStencilOpSeparate;

var _glTexParameteri = _emscripten_glTexParameteri;

var _glTexStorage2D = _emscripten_glTexStorage2D;

var _glTexStorage3D = _emscripten_glTexStorage3D;

var _glTexSubImage2D = _emscripten_glTexSubImage2D;

var _glTexSubImage3D = _emscripten_glTexSubImage3D;

var _glUniform1i = _emscripten_glUniform1i;

var _glUniform1iv = _emscripten_glUniform1iv;

var _glUniformBlockBinding = _emscripten_glUniformBlockBinding;

var _glUseProgram = _emscripten_glUseProgram;

var _glVertexAttrib4f = _emscripten_glVertexAttrib4f;

var _glVertexAttribDivisor = _emscripten_glVertexAttribDivisor;

var _glVertexAttribIPointer = _emscripten_glVertexAttribIPointer;

var _glVertexAttribPointer = _emscripten_glVertexAttribPointer;

var _glViewport = _emscripten_glViewport;

FS.createPreloadedFile = FS_createPreloadedFile;

FS.preloadFile = FS_preloadFile;

FS.staticInit();

for (let i = 0; i < 32; ++i) tempFixedLengthArray.push(new Array(i));

var miniTempWebGLIntBuffersStorage = new Int32Array(GL_POOL_TEMP_BUFFERS_SIZE);

for (let i = 0; i <= GL_POOL_TEMP_BUFFERS_SIZE; ++i) {
    miniTempWebGLIntBuffers[i] = miniTempWebGLIntBuffersStorage.subarray(0, i);
}

{
    if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
    if (Module["print"]) out = Module["print"];
    if (Module["printErr"]) err = Module["printErr"];
    if (Module["arguments"]) programArgs = Module["arguments"];
    if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
    var preInit = Module["preInit"];
    if (preInit) {
        if (typeof preInit === "function") Module["preInit"] = preInit = [ preInit ];
        while (preInit.length > 0) {
            preInit.shift()();
        }
    }
}

Module["addRunDependency"] = addRunDependency;

Module["removeRunDependency"] = removeRunDependency;

Module["FS_preloadFile"] = FS_preloadFile;

Module["FS_unlink"] = FS_unlink;

Module["FS_createPath"] = FS_createPath;

Module["FS_createDevice"] = FS_createDevice;

Module["FS_createDataFile"] = FS_createDataFile;

Module["FS_createLazyFile"] = FS_createLazyFile;

function net_claim(name) {
    const n = Module.uewNet;
    if (!n || !n.claim) return 0;
    const s = UTF8ToString(name >>> 0);
    if (!n.claim(s)) return 0;
    n.names = n.names || [ "" ];
    let i = n.names.indexOf(s);
    if (i < 0) {
        i = n.names.length;
        n.names.push(s);
    }
    return i;
}

net_claim.sig = "ii";

function net_open(route, port) {
    const n = Module.uewNet;
    const c = n && n.open ? n.open(n.names[route], port) : null;
    if (!c) return 0;
    n.conns = n.conns || [ null ];
    const id = n.conns.length;
    c.q = [];
    c.qlen = 0;
    c.closed = false;
    c.push = data => {
        if (data && data.length) {
            c.q.push(data);
            c.qlen += data.length;
        }
    };
    c.end = () => {
        c.closed = true;
    };
    n.conns.push(c);
    return id;
}

net_open.sig = "iii";

function net_send(id, p, n) {
    const c = Module.uewNet.conns[id];
    if (c && c.send) c.send(HEAPU8.slice(p >>> 0, (p >>> 0) + n));
}

net_send.sig = "viii";

function net_avail(id) {
    const c = Module.uewNet && Module.uewNet.conns ? Module.uewNet.conns[id] : null;
    if (!c) return -1;
    return c.qlen ? c.qlen : c.closed ? -1 : 0;
}

net_avail.sig = "ii";

function net_recv(id, p, cap) {
    const c = Module.uewNet.conns[id];
    if (!c) return -1;
    if (!c.qlen) return c.closed ? -1 : 0;
    let n = 0;
    while (n < cap && c.q.length) {
        const d = c.q[0], k = Math.min(cap - n, d.length);
        HEAPU8.set(d.subarray(0, k), (p >>> 0) + n >>> 0);
        n += k;
        if (k == d.length) c.q.shift(); else c.q[0] = d.subarray(k);
    }
    c.qlen -= n;
    return n;
}

net_recv.sig = "iiii";

function net_close(id) {
    const c = Module.uewNet && Module.uewNet.conns ? Module.uewNet.conns[id] : null;
    if (c) {
        if (c.close) c.close();
        Module.uewNet.conns[id] = null;
    }
}

net_close.sig = "vi";

function inet_claims(host) {
    const n = Module.uewNet;
    return n && n.http && (!n.claim || n.claim(UTF8ToString(host >>> 0))) ? 1 : 0;
}

inet_claims.sig = "ii";

function inet_request(method, url, headers, body, len, status, hlen) {
    const n = Module.uewNet;
    let r;
    try {
        r = n.http({
            method: UTF8ToString(method >>> 0),
            url: UTF8ToString(url >>> 0),
            headers: UTF8ToString(headers >>> 0),
            body: HEAPU8.slice(body >>> 0, (body >>> 0) + len)
        });
    } catch (e) {
        console.log("[net] handler failed: " + e);
        r = {
            status: 500,
            headers: {},
            body: ""
        };
    }
    r = r || {
        status: 404,
        headers: {},
        body: ""
    };
    let b = r.body;
    if (typeof b === "string") b = (new TextEncoder).encode(b); else if (b && !(b instanceof Uint8Array)) b = (new TextEncoder).encode(JSON.stringify(b));
    b = b || new Uint8Array(0);
    let h = "";
    const hs = Object.assign({
        "Content-Length": String(b.length)
    }, r.headers || {});
    for (const k in hs) h += k + ": " + hs[k] + "\r\n";
    n.last = {
        h: (new TextEncoder).encode(h),
        b: b
    };
    HEAP32[status >>> 0 >>> 2] = r.status || 200;
    HEAP32[hlen >>> 0 >>> 2] = n.last.h.length;
    return b.length;
}

inet_request.sig = "iiiiiiii";

function inet_take(headers, body) {
    const l = Module.uewNet.last;
    HEAPU8.set(l.h, headers >>> 0 >>> 0);
    HEAPU8.set(l.b, body >>> 0 >>> 0);
    Module.uewNet.last = null;
}

inet_take.sig = "vii";

function uew_vpx_available() {
    if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") return 0;
    if (typeof location !== "undefined" && /[?&]swvideo=1/.test(location.search)) return 0;
    return Module.uewHwVideo === false ? 0 : 1;
}

uew_vpx_available.sig = "i";

function uew_vpx_open(vp9) {
    const V = Module.uewVpx || (Module.uewVpx = {
        n: 0,
        s: new Map
    });
    const id = ++V.n, s = {
        vp9: vp9,
        ready: [],
        err: false,
        ts: 0
    };
    try {
        s.dec = new VideoDecoder({
            output: f => {
                const rect = f.visibleRect, cs = f.colorSpace || {}, fmt = f.format;
                if (fmt !== "I420" && fmt !== "NV12") {
                    if (!V.fmtLogged) {
                        V.fmtLogged = 1;
                        console.log("[video] decoder gives " + fmt + " pictures; using the software decoder");
                    }
                    f.close();
                    s.err = true;
                    return;
                }
                let buf;
                try {
                    buf = new Uint8Array(f.allocationSize({
                        rect: rect
                    }));
                } catch (e) {
                    f.close();
                    s.err = true;
                    return;
                }
                const item = {
                    buf: buf,
                    layout: null,
                    fmt: fmt,
                    w: rect.width,
                    h: rect.height,
                    matrix: cs.matrix || "",
                    full: !!cs.fullRange
                };
                s.ready.push(item);
                f.copyTo(buf, {
                    rect: rect
                }).then(layout => {
                    item.layout = layout;
                    f.close();
                }, () => {
                    f.close();
                    s.err = true;
                });
            },
            error: e => {
                s.err = true;
                if (!V.errLogged) {
                    V.errLogged = 1;
                    console.log("[video] hardware decoder failed (" + e.message + "); using the software decoder");
                }
            }
        });
    } catch (e) {
        return 0;
    }
    V.s.set(id, s);
    return id;
}

uew_vpx_open.sig = "ii";

function uew_vpx_decode(id, p, n, key) {
    const s = Module.uewVpx.s.get(id);
    if (!s || s.err) return -1;
    try {
        if (s.dec.state === "unconfigured") {
            if (!key) return -1;
            s.dec.configure({
                codec: s.vp9 ? "vp09.00.10.08" : "vp8",
                optimizeForLatency: true,
                hardwareAcceleration: "prefer-hardware"
            });
        }
        p >>>= 0;
        s.dec.decode(new EncodedVideoChunk({
            type: key ? "key" : "delta",
            timestamp: ++s.ts,
            data: HEAPU8.slice(p, p + n)
        }));
        return 0;
    } catch (e) {
        s.err = true;
        return -1;
    }
}

uew_vpx_decode.sig = "iiiii";

function uew_vpx_poll(id) {
    const s = Module.uewVpx.s.get(id);
    if (!s || s.err) return 2;
    return s.ready.length && s.ready[0].layout ? 1 : 0;
}

uew_vpx_poll.sig = "ii";

function uew_vpx_info(id, out) {
    const s = Module.uewVpx.s.get(id), f = s && s.ready[0];
    if (!f) return 0;
    out >>>= 2;
    HEAP32[out >>> 0] = f.w;
    HEAP32[out + 1 >>> 0] = f.h;
    HEAP32[out + 2 >>> 0] = f.matrix === "bt709" ? 2 : f.matrix === "bt470bg" ? 1 : f.matrix === "smpte170m" ? 3 : f.matrix === "smpte240m" ? 4 : f.matrix.startsWith("bt2020") ? 5 : f.matrix === "rgb" ? 7 : 0;
    HEAP32[out + 3 >>> 0] = f.full ? 1 : 0;
    return 1;
}

uew_vpx_info.sig = "iii";

function uew_vpx_take(id, y, ys, u, us, v, vs) {
    const s = Module.uewVpx.s.get(id), f = s && s.ready.shift();
    if (!f) return;
    const L = f.layout, b = f.buf, w = f.w, h = f.h, cw = w + 1 >> 1, ch = h + 1 >> 1, H = HEAPU8;
    y >>>= 0;
    u >>>= 0;
    v >>>= 0;
    for (let r = 0; r < h; r++) H.set(b.subarray(L[0].offset + r * L[0].stride, L[0].offset + r * L[0].stride + w), y + r * ys);
    if (f.fmt === "I420") {
        for (let r = 0; r < ch; r++) {
            H.set(b.subarray(L[1].offset + r * L[1].stride, L[1].offset + r * L[1].stride + cw), u + r * us);
            H.set(b.subarray(L[2].offset + r * L[2].stride, L[2].offset + r * L[2].stride + cw), v + r * vs);
        }
    } else {
        for (let r = 0; r < ch; r++) {
            let o = L[1].offset + r * L[1].stride, du = u + r * us, dv = v + r * vs;
            for (let x = 0; x < cw; x++, o += 2) {
                H[du + x] = b[o];
                H[dv + x] = b[o + 1];
            }
        }
    }
}

uew_vpx_take.sig = "viiiiiii";

function uew_vpx_close(id) {
    const V = Module.uewVpx, s = V && V.s.get(id);
    if (!s) return;
    try {
        if (s.dec.state !== "closed") s.dec.close();
    } catch (e) {}
    V.s.delete(id);
}

uew_vpx_close.sig = "vi";

function __asyncjs__uew_js_switch(from, to, target) {
    return Asyncify.handleAsync(async () => {
        Module.uewRes = Module.uewRes || {};
        await new Promise(resolve => {
            Module.uewRes[from] = resolve;
            const r = Module.uewRes[to];
            if (r) {
                delete Module.uewRes[to];
                r();
            } else Module._uew_ctx_start(target);
        });
    });
}

__asyncjs__uew_js_switch.sig = "viii";

function uew_js_ctx_drop(id) {
    if (Module.uewRes) delete Module.uewRes[id];
}

uew_js_ctx_drop.sig = "vi";

function __asyncjs__uew_js_sleep(ms) {
    return Asyncify.handleAsync(async () => {
        await new Promise(r => setTimeout(r, ms));
    });
}

__asyncjs__uew_js_sleep.sig = "vi";

function __asyncjs__uew_js_yield() {
    return Asyncify.handleAsync(async () => {
        await new Promise(r => {
            if (typeof setImmediate === "function") {
                setImmediate(r);
                return;
            }
            const ch = Module.uewYieldCh || (Module.uewYieldCh = new MessageChannel);
            ch.port1.onmessage = () => r();
            ch.port2.postMessage(0);
        });
    });
}

__asyncjs__uew_js_yield.sig = "v";

function uew_js_frame_request() {
    if (!Module.uewWatchdog && typeof setInterval !== "undefined" && typeof document !== "undefined") {
        let last = -1, since = performance.now(), dumped = false;
        Module.uewWatchdog = setInterval(() => {
            const n = Module.uewPresents || 0, now = performance.now();
            if (n !== last || document.visibilityState !== "visible") {
                last = n;
                since = now;
                dumped = false;
                return;
            }
            if (!dumped && n > 600 && now - since > 8e3 && Module._uew_threads) {
                dumped = true;
                console.log("[watchdog] no frame for 8 s; threads:");
                Module._uew_threads();
            }
        }, 1e3);
    }
    if (Module.uewFramePending) return;
    Module.uewFramePending = 1;
    const go = () => {
        Module.uewFramePending = 0;
        Module.uewFrameSeq = (Module.uewFrameSeq | 0) + 1;
        const w = Module.uewIdleWake;
        if (w) {
            Module.uewIdleWake = null;
            w();
        }
    };
    (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : setTimeout)(go);
}

uew_js_frame_request.sig = "v";

function uew_js_frame_seq() {
    return Module.uewFrameSeq | 0;
}

uew_js_frame_seq.sig = "i";

function __asyncjs__uew_js_idle(ms) {
    return Asyncify.handleAsync(async () => {
        await new Promise(r => {
            let done = false;
            const fin = () => {
                if (!done) {
                    done = true;
                    Module.uewIdleWake = null;
                    r();
                }
            };
            Module.uewIdleWake = fin;
            if (ms < 3) {
                if (typeof setImmediate === "function") {
                    setImmediate(fin);
                    return;
                }
                const ch = Module.uewIdleCh || (Module.uewIdleCh = new MessageChannel);
                ch.port1.onmessage = () => fin();
                ch.port2.postMessage(0);
            } else setTimeout(fin, ms - 1);
        });
    });
}

__asyncjs__uew_js_idle.sig = "vd";

function web_input_init() {
    if (Module.uewInput) return;
    const q = Module.uewInput = [];
    const canvas = Module.canvas || typeof document !== "undefined" && document.getElementById("canvas");
    if (!canvas) return;
    const codes = {
        Escape: 27,
        Tab: 9,
        Enter: 13,
        Space: 32,
        Backspace: 8,
        ShiftLeft: 160,
        ShiftRight: 161,
        ControlLeft: 162,
        ControlRight: 163,
        AltLeft: 164,
        AltRight: 165,
        CapsLock: 20,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Insert: 45,
        Delete: 46,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
        Backquote: 192,
        Minus: 189,
        Equal: 187,
        BracketLeft: 219,
        BracketRight: 221,
        Backslash: 220,
        Semicolon: 186,
        Quote: 222,
        Comma: 188,
        Period: 190,
        Slash: 191
    };
    const vk = e => {
        if (codes[e.code]) return codes[e.code];
        if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3);
        if (/^Digit[0-9]$/.test(e.code)) return e.code.charCodeAt(5);
        if (/^F([1-9]|1[0-2])$/.test(e.code)) return 111 + parseInt(e.code.slice(1));
        if (/^Numpad[0-9]$/.test(e.code)) return 96 + parseInt(e.code.slice(6));
        return 0;
    };
    const generic = k => k === 160 || k === 161 ? 16 : k === 162 || k === 163 ? 17 : k === 164 || k === 165 ? 18 : 0;
    const key = down => e => {
        const k = vk(e);
        if (!k) return;
        e.preventDefault();
        const g = generic(k);
        if (g) q.push([ down ? 1 : 2, g, 0, 0, 0 ]);
        q.push([ down ? 1 : 2, k, 0, 0, 0 ]);
        if (down && e.key.length === 1) q.push([ 3, e.key.codePointAt(0), 0, 0, 0 ]);
    };
    window.addEventListener("keydown", key(true));
    window.addEventListener("keyup", key(false));
    const pos = e => {
        const r = canvas.getBoundingClientRect();
        return [ Math.round((e.clientX - r.left) * canvas.width / r.width), Math.round((e.clientY - r.top) * canvas.height / r.height) ];
    };
    canvas.addEventListener("mousemove", e => {
        const [x, y] = pos(e);
        q.push([ 4, x, y, e.movementX | 0, e.movementY | 0 ]);
    });
    const btn = [ 0, 2, 1, 3, 4 ];
    canvas.addEventListener("mousedown", e => {
        e.preventDefault();
        q.push([ 5, btn[e.button] ?? 0, 1, 0, 0 ]);
    });
    window.addEventListener("mouseup", e => q.push([ 5, btn[e.button] ?? 0, 0, 0, 0 ]));
    canvas.addEventListener("wheel", e => {
        e.preventDefault();
        q.push([ 6, e.deltaY < 0 ? 1 : -1, 0, 0, 0 ]);
    }, {
        passive: false
    });
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    window.addEventListener("focus", () => q.push([ 8, 1, 0, 0, 0 ]));
    window.addEventListener("blur", () => q.push([ 8, 0, 0, 0, 0 ]));
    if (Module.uewAutoSize) new ResizeObserver(() => {
        const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)), h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
        if (w !== canvas.width || h !== canvas.height) {
            canvas.width = w;
            canvas.height = h;
            q.push([ 7, w, h, 0, 0 ]);
        }
    }).observe(canvas);
}

web_input_init.sig = "v";

function host_gamepad(index, buttons, triggers, sticks) {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    const p = Array.from(pads).filter(x => x && x.connected)[index];
    if (!p) return 0;
    const b = p.buttons, on = i => b[i] && b[i].pressed;
    const bits = [ [ 12, 1 ], [ 13, 2 ], [ 14, 4 ], [ 15, 8 ], [ 9, 16 ], [ 8, 32 ], [ 10, 64 ], [ 11, 128 ], [ 4, 256 ], [ 5, 512 ], [ 16, 1024 ], [ 0, 4096 ], [ 1, 8192 ], [ 2, 16384 ], [ 3, 32768 ] ];
    let m = 0;
    for (const [i, bit] of bits) if (on(i)) m |= bit;
    HEAPU16[buttons >>> 1 >>> 0] = m;
    HEAPU8[triggers >>> 0 >>> 0] = Math.round((b[6] ? b[6].value : 0) * 255);
    HEAPU8[(triggers >>> 0) + 1 >>> 0] = Math.round((b[7] ? b[7].value : 0) * 255);
    const ax = (i, flip) => {
        const v = (p.axes[i] || 0) * (flip ? -1 : 1);
        return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    };
    HEAP16[sticks >>> 1 >>> 0] = ax(0);
    HEAP16[(sticks >>> 1) + 1 >>> 0] = ax(1, true);
    HEAP16[(sticks >>> 1) + 2 >>> 0] = ax(2);
    HEAP16[(sticks >>> 1) + 3 >>> 0] = ax(3, true);
    return 1;
}

host_gamepad.sig = "iiiii";

function js_audio_open(rate) {
    if (Module.uewAudio) return 1;
    if (typeof AudioContext === "undefined" || !globalThis.AudioWorkletNode) return 0;
    const A = Module.uewAudio = {
        ctx: new AudioContext({
            sampleRate: rate,
            latencyHint: "interactive"
        }),
        node: null,
        pushed: 0,
        start: -1,
        rate: rate,
        pending: []
    };
    const code = `class P extends AudioWorkletProcessor { constructor() { super(); this.q = []; this.off = 0; this.port.onmessage = (e) => this.q.push(e.data); } process(inp, out) { const L = out[0][0], R = out[0][1] || out[0][0]; for (let i = 0; i < L.length; i++) { while (this.q.length && this.off >= this.q[0].length) { this.q.shift(); this.off = 0; } if (!this.q.length) { L[i] = 0; R[i] = 0; continue; } const b = this.q[0]; L[i] = b[this.off]; R[i] = b[this.off + 1]; this.off += 2; } return true; } } registerProcessor("uew-out", P);`;
    const url = URL.createObjectURL(new Blob([ code ], {
        type: "text/javascript"
    }));
    A.ctx.audioWorklet.addModule(url).then(() => {
        A.node = new AudioWorkletNode(A.ctx, "uew-out", {
            outputChannelCount: [ 2 ]
        });
        A.node.connect(A.ctx.destination);
        for (const b of A.pending) A.node.port.postMessage(b, [ b.buffer ]);
        A.pending = [];
    });
    const resume = () => {
        if (A.ctx.state !== "running") A.ctx.resume();
    };
    for (const ev of [ "keydown", "mousedown", "touchstart", "pointerdown" ]) window.addEventListener(ev, resume, {
        capture: true
    });
    return 1;
}

js_audio_open.sig = "ii";

function js_audio_queued() {
    const A = Module.uewAudio;
    if (!A) return 0;
    const live = A.ctx.state === "running" && !!A.node;
    const now = live ? A.ctx.currentTime : performance.now() / 1e3;
    if (A.live !== live || A.start < 0) {
        A.live = live;
        A.start = now;
        A.pushed = 0;
    }
    const played = (now - A.start) * A.rate;
    if (A.pushed < played) {
        A.start = now;
        A.pushed = 0;
        return 0;
    }
    return Math.round(A.pushed - played);
}

js_audio_queued.sig = "i";

function js_audio_restart() {
    const A = Module.uewAudio;
    if (A) A.start = -1;
}

js_audio_restart.sig = "v";

function js_audio_write(frames, count) {
    const A = Module.uewAudio;
    if (!A) return;
    const src = HEAPF32.subarray(frames >>> 2 >>> 0, (frames >>> 2) + count * 2 >>> 0);
    for (let i = 0; i < src.length; i += 8) {
        const v = Math.abs(src[i]);
        if (v > (A.peak || 0)) A.peak = v;
    }
    if (!A.live) {
        A.pushed += count;
        return;
    }
    const b = new Float32Array(count * 2);
    b.set(src);
    A.pushed += count;
    if (A.node) A.node.port.postMessage(b, [ b.buffer ]); else if (A.pending.length < 64) A.pending.push(b);
}

js_audio_write.sig = "vii";

function host_rumble(index, lo, hi) {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    const p = Array.from(pads).filter(x => x && x.connected)[index];
    const a = p && p.vibrationActuator;
    if (a && a.playEffect) a.playEffect("dual-rumble", {
        duration: 200,
        strongMagnitude: lo / 65535,
        weakMagnitude: hi / 65535
    }).catch(() => {});
}

host_rumble.sig = "viii";

function web_next_event(out) {
    const q = Module.uewInput;
    if (!q || !q.length) return 0;
    const e = q.shift();
    for (let i = 0; i < 5; i++) HEAP32[(out >>> 2) + i >>> 0] = e[i];
    return 1;
}

web_next_event.sig = "ii";

function host_query_flag(name) {
    if (typeof location === "undefined") return 0;
    return new RegExp("[?&]" + UTF8ToString(name >>> 0) + "=1(&|$)").test(location.search) ? 1 : 0;
}

host_query_flag.sig = "ii";

function host_query_int(name) {
    if (typeof location === "undefined") return 0;
    const m = new RegExp("[?&]" + UTF8ToString(name >>> 0) + "=(d+)").exec(location.search);
    return m ? +m[1] : 0;
}

host_query_int.sig = "ii";

function web_trace_filter() {
    const s = typeof window !== "undefined" && window.uewTraceOnly || "";
    return stringToNewUTF8(s ? "," + s + "," : "");
}

web_trace_filter.sig = "i";

function __asyncjs__host_frame_yield() {
    return Asyncify.handleAsync(async () => {
        await new Promise(r => (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : setTimeout)(r));
    });
}

function web_canvas_w() {
    const c = Module.canvas || typeof document !== "undefined" && document.getElementById("canvas");
    return c ? c.width : 1280;
}

web_canvas_w.sig = "i";

function web_canvas_h() {
    const c = Module.canvas || typeof document !== "undefined" && document.getElementById("canvas");
    return c ? c.height : 720;
}

web_canvas_h.sig = "i";

function host_show_cursor(show) {
    const c = Module.canvas;
    if (c) c.style.cursor = show ? "default" : "none";
}

host_show_cursor.sig = "vi";

function host_lock_pointer(lock) {
    const c = Module.canvas;
    if (!c || typeof document === "undefined") return;
    Module.uewWantLock = !!lock;
    if (!lock && document.pointerLockElement === c) document.exitPointerLock();
    if (lock && !Module.uewLockHooked) {
        Module.uewLockHooked = true;
        c.addEventListener("click", () => {
            if (!Module.uewWantLock || document.pointerLockElement === c) return;
            try {
                const p = c.requestPointerLock();
                if (p && p.catch) p.catch(() => {});
            } catch (e) {}
        });
    }
}

host_lock_pointer.sig = "vi";

function uew_rf_find(path, size, mtime) {
    const f = Module.uewFiles && Module.uewFiles.lookup(UTF8ToString(path >>> 0));
    if (!f) return -2;
    HEAPF64[size >>> 3 >>> 0] = f.size || 0;
    HEAPF64[mtime >>> 3 >>> 0] = f.mtime || 0;
    return f.dir ? -1 : f.id;
}

uew_rf_find.sig = "iiii";

function uew_rf_list(path) {
    const s = Module.uewFiles && Module.uewFiles.list(UTF8ToString(path >>> 0));
    return s == null ? 0 : stringToNewUTF8(s);
}

uew_rf_list.sig = "ii";

function uew_rf_read_cached(id, off, len, dst) {
    return Module.uewFiles.readCached(id, off, len, dst);
}

uew_rf_read_cached.sig = "iidii";

function __asyncjs__uew_rf_read(id, off, len, dst) {
    return Asyncify.handleAsync(async () => await Module.uewFiles.read(id, off, len, dst));
}

__asyncjs__uew_rf_read.sig = "iidii";

function uew_rf_start(id, off, len) {
    Module.uewFiles.start(id, off, len);
}

uew_rf_start.sig = "vidi";

function uew_rf_ready(id, off, len) {
    return Module.uewFiles.ready(id, off, len);
}

uew_rf_ready.sig = "iidi";

var _malloc, _fflush, _uew_threads, _uew_ue_console, _uew_set_speed, _uew_ctx_start, _main, _uew_set_trace, ___funcs_on_exit, __emscripten_stack_alloc, memory, __indirect_function_table, wasmMemory;

function assignWasmExports(wasmExports) {
    _malloc = wasmExports["malloc"];
    _fflush = wasmExports["fflush"];
    _uew_threads = Module["_uew_threads"] = wasmExports["uew_threads"];
    _uew_ue_console = Module["_uew_ue_console"] = wasmExports["uew_ue_console"];
    _uew_set_speed = Module["_uew_set_speed"] = wasmExports["uew_set_speed"];
    _uew_ctx_start = Module["_uew_ctx_start"] = wasmExports["uew_ctx_start"];
    _main = Module["_main"] = wasmExports["__main_argc_argv"];
    _uew_set_trace = Module["_uew_set_trace"] = wasmExports["uew_set_trace"];
    ___funcs_on_exit = wasmExports["__funcs_on_exit"];
    __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
    memory = wasmMemory = wasmExports["memory"];
    __indirect_function_table = wasmExports["__indirect_function_table"];
}

var wasmImports = {
    __asyncjs__uew_js_idle: __asyncjs__uew_js_idle,
    __asyncjs__uew_js_sleep: __asyncjs__uew_js_sleep,
    __asyncjs__uew_js_switch: __asyncjs__uew_js_switch,
    __asyncjs__uew_js_yield: __asyncjs__uew_js_yield,
    __asyncjs__uew_rf_read: __asyncjs__uew_rf_read,
    __syscall_fcntl64: ___syscall_fcntl64,
    __syscall_fstat64: ___syscall_fstat64,
    __syscall_ftruncate64: ___syscall_ftruncate64,
    __syscall_getdents64: ___syscall_getdents64,
    __syscall_ioctl: ___syscall_ioctl,
    __syscall_lstat64: ___syscall_lstat64,
    __syscall_mkdirat: ___syscall_mkdirat,
    __syscall_newfstatat: ___syscall_newfstatat,
    __syscall_openat: ___syscall_openat,
    __syscall_renameat: ___syscall_renameat,
    __syscall_rmdir: ___syscall_rmdir,
    __syscall_stat64: ___syscall_stat64,
    __syscall_unlinkat: ___syscall_unlinkat,
    _gmtime_js: __gmtime_js,
    _timegm_js: __timegm_js,
    _tzset_js: __tzset_js,
    clock_time_get: _clock_time_get,
    emscripten_get_canvas_element_size: _emscripten_get_canvas_element_size,
    emscripten_get_now: _emscripten_get_now,
    emscripten_resize_heap: _emscripten_resize_heap,
    emscripten_webgl_create_context: _emscripten_webgl_create_context,
    emscripten_webgl_enable_extension: _emscripten_webgl_enable_extension,
    emscripten_webgl_make_context_current: _emscripten_webgl_make_context_current,
    environ_get: _environ_get,
    environ_sizes_get: _environ_sizes_get,
    exit: _exit,
    fd_close: _fd_close,
    fd_read: _fd_read,
    fd_seek: _fd_seek,
    fd_write: _fd_write,
    glActiveTexture: _glActiveTexture,
    glAttachShader: _glAttachShader,
    glBindBuffer: _glBindBuffer,
    glBindBufferRange: _glBindBufferRange,
    glBindFramebuffer: _glBindFramebuffer,
    glBindSampler: _glBindSampler,
    glBindTexture: _glBindTexture,
    glBindVertexArray: _glBindVertexArray,
    glBlendColor: _glBlendColor,
    glBlendEquationSeparate: _glBlendEquationSeparate,
    glBlendFuncSeparate: _glBlendFuncSeparate,
    glBlitFramebuffer: _glBlitFramebuffer,
    glBufferData: _glBufferData,
    glBufferSubData: _glBufferSubData,
    glClearBufferfi: _glClearBufferfi,
    glClearBufferfv: _glClearBufferfv,
    glClearBufferiv: _glClearBufferiv,
    glClearBufferuiv: _glClearBufferuiv,
    glColorMask: _glColorMask,
    glCompileShader: _glCompileShader,
    glCompressedTexSubImage2D: _glCompressedTexSubImage2D,
    glCompressedTexSubImage3D: _glCompressedTexSubImage3D,
    glCopyBufferSubData: _glCopyBufferSubData,
    glCopyTexSubImage2D: _glCopyTexSubImage2D,
    glCopyTexSubImage3D: _glCopyTexSubImage3D,
    glCreateProgram: _glCreateProgram,
    glCreateShader: _glCreateShader,
    glCullFace: _glCullFace,
    glDeleteFramebuffers: _glDeleteFramebuffers,
    glDeleteProgram: _glDeleteProgram,
    glDeleteShader: _glDeleteShader,
    glDepthFunc: _glDepthFunc,
    glDepthMask: _glDepthMask,
    glDepthRangef: _glDepthRangef,
    glDisable: _glDisable,
    glDisableVertexAttribArray: _glDisableVertexAttribArray,
    glDrawArrays: _glDrawArrays,
    glDrawArraysInstanced: _glDrawArraysInstanced,
    glDrawBuffers: _glDrawBuffers,
    glDrawElements: _glDrawElements,
    glDrawElementsInstanced: _glDrawElementsInstanced,
    glEnable: _glEnable,
    glEnableVertexAttribArray: _glEnableVertexAttribArray,
    glFramebufferTexture2D: _glFramebufferTexture2D,
    glFramebufferTextureLayer: _glFramebufferTextureLayer,
    glFrontFace: _glFrontFace,
    glGenBuffers: _glGenBuffers,
    glGenFramebuffers: _glGenFramebuffers,
    glGenSamplers: _glGenSamplers,
    glGenTextures: _glGenTextures,
    glGenVertexArrays: _glGenVertexArrays,
    glGetProgramInfoLog: _glGetProgramInfoLog,
    glGetProgramiv: _glGetProgramiv,
    glGetShaderInfoLog: _glGetShaderInfoLog,
    glGetShaderiv: _glGetShaderiv,
    glGetUniformBlockIndex: _glGetUniformBlockIndex,
    glGetUniformLocation: _glGetUniformLocation,
    glLinkProgram: _glLinkProgram,
    glPixelStorei: _glPixelStorei,
    glPolygonOffset: _glPolygonOffset,
    glSamplerParameterf: _glSamplerParameterf,
    glSamplerParameteri: _glSamplerParameteri,
    glScissor: _glScissor,
    glShaderSource: _glShaderSource,
    glStencilFuncSeparate: _glStencilFuncSeparate,
    glStencilMask: _glStencilMask,
    glStencilOpSeparate: _glStencilOpSeparate,
    glTexParameteri: _glTexParameteri,
    glTexStorage2D: _glTexStorage2D,
    glTexStorage3D: _glTexStorage3D,
    glTexSubImage2D: _glTexSubImage2D,
    glTexSubImage3D: _glTexSubImage3D,
    glUniform1i: _glUniform1i,
    glUniform1iv: _glUniform1iv,
    glUniformBlockBinding: _glUniformBlockBinding,
    glUseProgram: _glUseProgram,
    glVertexAttrib4f: _glVertexAttrib4f,
    glVertexAttribDivisor: _glVertexAttribDivisor,
    glVertexAttribIPointer: _glVertexAttribIPointer,
    glVertexAttribPointer: _glVertexAttribPointer,
    glViewport: _glViewport,
    host_gamepad: host_gamepad,
    host_lock_pointer: host_lock_pointer,
    host_query_flag: host_query_flag,
    host_query_int: host_query_int,
    host_rumble: host_rumble,
    host_show_cursor: host_show_cursor,
    inet_claims: inet_claims,
    inet_request: inet_request,
    inet_take: inet_take,
    js_audio_open: js_audio_open,
    js_audio_queued: js_audio_queued,
    js_audio_restart: js_audio_restart,
    js_audio_write: js_audio_write,
    net_avail: net_avail,
    net_claim: net_claim,
    net_close: net_close,
    net_open: net_open,
    net_recv: net_recv,
    net_send: net_send,
    uew_js_ctx_drop: uew_js_ctx_drop,
    uew_js_frame_request: uew_js_frame_request,
    uew_js_frame_seq: uew_js_frame_seq,
    uew_rf_find: uew_rf_find,
    uew_rf_list: uew_rf_list,
    uew_rf_read_cached: uew_rf_read_cached,
    uew_rf_ready: uew_rf_ready,
    uew_rf_start: uew_rf_start,
    uew_vpx_available: uew_vpx_available,
    uew_vpx_close: uew_vpx_close,
    uew_vpx_decode: uew_vpx_decode,
    uew_vpx_info: uew_vpx_info,
    uew_vpx_open: uew_vpx_open,
    uew_vpx_poll: uew_vpx_poll,
    uew_vpx_take: uew_vpx_take,
    uewg_begin_pass: _uewg_begin_pass,
    uewg_bindgroup_create: _uewg_bindgroup_create,
    uewg_buffer_copy: _uewg_buffer_copy,
    uewg_buffer_copy_ring: _uewg_buffer_copy_ring,
    uewg_buffer_create: _uewg_buffer_create,
    uewg_buffer_write: _uewg_buffer_write,
    uewg_clear: _uewg_clear,
    uewg_clear_buffer: _uewg_clear_buffer,
    uewg_compute_pipeline_create: _uewg_compute_pipeline_create,
    uewg_copy_buffer: _uewg_copy_buffer,
    uewg_copy_texture: _uewg_copy_texture,
    uewg_dispatch: _uewg_dispatch,
    uewg_draw: _uewg_draw,
    uewg_expand_typed: _uewg_expand_typed,
    uewg_flush: _uewg_flush,
    uewg_gen_mips: _uewg_gen_mips,
    uewg_gs: _uewg_gs,
    uewg_init: _uewg_init,
    uewg_layout_create: _uewg_layout_create,
    uewg_max_dynamic_ubo: _uewg_max_dynamic_ubo,
    uewg_max_storage: _uewg_max_storage,
    uewg_pipe_ready: _uewg_pipe_ready,
    uewg_present: _uewg_present,
    uewg_readback_done: _uewg_readback_done,
    uewg_readback_finish: _uewg_readback_finish,
    uewg_readback_latest: _uewg_readback_latest,
    uewg_readback_start: _uewg_readback_start,
    uewg_release: _uewg_release,
    uewg_render_pipeline_create: _uewg_render_pipeline_create,
    uewg_retire: _uewg_retire,
    uewg_ring_reset: _uewg_ring_reset,
    uewg_ring_used_at: _uewg_ring_used_at,
    uewg_sampler_create: _uewg_sampler_create,
    uewg_shader_create: _uewg_shader_create,
    uewg_submit: _uewg_submit,
    uewg_texture_copy_ring: _uewg_texture_copy_ring,
    uewg_texture_create: _uewg_texture_create,
    uewg_texture_write: _uewg_texture_write,
    uewg_timestamp: _uewg_timestamp,
    uewg_timestamp_get: _uewg_timestamp_get,
    uewg_view_create: _uewg_view_create,
    web_canvas_h: web_canvas_h,
    web_canvas_w: web_canvas_w,
    web_input_init: web_input_init,
    web_next_event: web_next_event,
    web_trace_filter: web_trace_filter
};

function applySignatureConversions(wasmExports) {
    var makeWrapper_pp = f => a0 => f(a0) >>> 0;
    var origExports = wasmExports;
    wasmExports = {};
    wasmExports["malloc"] = makeWrapper_pp(origExports["malloc"]);
    wasmExports["_emscripten_stack_alloc"] = makeWrapper_pp(origExports["_emscripten_stack_alloc"]);
    Object.setPrototypeOf(wasmExports, origExports);
    return wasmExports;
}

async function callMain(args = []) {
    var entryFunction = _main;
    args.unshift(thisProgram);
    var argc = args.length;
    var argv = stackAlloc((argc + 1) * 4);
    var argv_ptr = argv;
    for (var arg of args) {
        HEAPU32[argv_ptr >>> 2 >>> 0] = stringToUTF8OnStack(arg);
        argv_ptr += 4;
    }
    HEAPU32[argv_ptr >>> 2 >>> 0] = 0;
    try {
        var ret = entryFunction(argc, argv);
        ret = await ret;
        exitJS(ret, true);
        return ret;
    } catch (e) {
        return handleException(e);
    }
}

async function run(args = programArgs) {
    preRun();
    if (runDependencies) {
        await resolveRunDependencies();
    }
    var setStatus = Module["setStatus"];
    if (setStatus) {
        setStatus("Running...");
        await new Promise(resolve => setTimeout(resolve, 1));
        setTimeout(setStatus, 1, "");
    }
    if (ABORT) return;
    initRuntime();
    Module["onRuntimeInitialized"]?.();
    var noInitialRun = Module["noInitialRun"] || false;
    if (!noInitialRun) await callMain(args);
    postRun();
}

var wasmExports;

createWasm().then(() => run());
