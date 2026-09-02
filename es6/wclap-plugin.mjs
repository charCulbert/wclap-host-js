import expandTarGz from "./targz.mjs"
import {importedMemoryLimits} from "./wasm-memory.mjs"

// Preserve the upstream wasm32 ceiling by default; applications targeting
// tighter environments can supply a smaller public plug-in memory limit.
export const maximumMemoryPages = 32768;
const wasmPageBytes = 65536;
const resourceHeadroomBytes = 16*1024*1024;
const maximumResourceMemoryPages = 32768;

function codedError(code, message, details = {}) {
	let error = new Error(message);
	error.code = code;
	Object.assign(error, details);
	return error;
}

function bundleLimitError(limitBytes, observedBytes, stage,
	requiredBytes = observedBytes) {
	return codedError("bundle-limit",
		`WCLAP ${stage} exceeded the ${limitBytes}-byte bundle limit`, {
			stage, limitBytes, observedBytes, requiredBytes,
			suggestedLimits: {bundleBytes: requiredBytes},
		});
}

function checkedFile(path, value) {
	if (!path || path.includes("\0") || path.includes("\\")
		|| path.startsWith("/") || /^[A-Za-z]:/.test(path)
		|| path.split("/").some(part => part === "..")) {
		throw codedError("invalid-archive", `Invalid WCLAP file path: ${path}`);
	}
	if (!(value instanceof ArrayBuffer)
		&& !(typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer)
		&& !ArrayBuffer.isView(value))
		throw new TypeError(`WCLAP file ${path} must contain binary data`);
	path = path.split("/").filter(part => part && part !== ".").join("/");
	if (!path) throw codedError("invalid-archive", `Invalid WCLAP file path: ${path}`);
	return {path, value};
}

function sharedFile(value, shareFiles) {
	if (!shareFiles || typeof SharedArrayBuffer !== "function") return value;
	if (value instanceof SharedArrayBuffer
		|| ArrayBuffer.isView(value) && value.buffer instanceof SharedArrayBuffer) return value;
	let source = ArrayBuffer.isView(value)
		? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		: new Uint8Array(value);
	let copy;
	try {
		copy = new Uint8Array(new SharedArrayBuffer(source.byteLength));
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		throw codedError("memory-unavailable",
			`The browser could not allocate a ${source.byteLength}-byte shared WCLAP resource`, {
				stage: "shared resource", requiredBytes: source.byteLength,
				retryable: true, cause: error,
			});
	}
	copy.set(source);
	return copy.buffer;
}

function memoryHints(files) {
	let entry = Object.entries(files).find(([path]) => /(^|\/)memory\.json$/.test(path));
	if (!entry) return null;
	let value;
	try {
		let bytes = ArrayBuffer.isView(entry[1])
			? new Uint8Array(entry[1].buffer, entry[1].byteOffset, entry[1].byteLength)
			: new Uint8Array(entry[1]);
		// Chromium's TextDecoder rejects even a typed view backed by shared memory.
		// The metadata is tiny, so copy it to an ordinary ArrayBuffer for parsing.
		value = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
	} catch (error) {
		throw codedError("invalid-archive", "Invalid memory.json", {cause: error});
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw codedError("invalid-archive", "memory.json must contain an object");
	let result = {};
	for (let name of ["minimumBytes", "recommendedInitialBytes", "recommendedMaximumBytes"]) {
		if (!Number.isSafeInteger(value[name]) || value[name] < wasmPageBytes)
			throw codedError("invalid-archive", `memory.json has invalid ${name}`);
		result[name] = value[name];
	}
	if (result.recommendedInitialBytes < result.minimumBytes
			|| result.recommendedMaximumBytes < result.recommendedInitialBytes) {
		throw codedError("invalid-archive", "memory.json memory recommendations are out of order");
	}
	if (value.shared === false)
		throw codedError("invalid-archive", "WCLAP processing requires shared memory");
	return result;
}

function boundedResponse(response, limitBytes, previousBytes = 0) {
	if (!response.ok) {
		throw codedError("http-error",
			`WCLAP request failed with HTTP ${response.status}`, {
				stage: "received source", status: response.status,
			});
	}
	let contentLength = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(contentLength) && previousBytes + contentLength > limitBytes)
		throw bundleLimitError(limitBytes, previousBytes + contentLength, "received source");
	if (!response.body)
		throw codedError("http-error", "WCLAP response has no body", {stage: "received source"});

	let observedBytes = previousBytes;
	let body = response.body.pipeThrough(new TransformStream({
		transform(chunk, controller) {
			observedBytes += chunk.byteLength;
			if (observedBytes > limitBytes)
				throw bundleLimitError(limitBytes, observedBytes, "received source");
			controller.enqueue(chunk);
		},
	}));
	return new Response(body, {headers: response.headers});
}

function resourceMemorySpec(files) {
	let resourceBytes = Object.values(files).reduce(
		(total, bytes) => total + (bytes?.byteLength || 0), 0);
	let maximum = Math.max(256,
		Math.ceil((resourceBytes + resourceHeadroomBytes)/wasmPageBytes));
	return {
		resourceBytes,
		memorySpec: {
			initial: 8,
			maximum: Math.min(maximum, maximumResourceMemoryPages),
			shared: true,
		},
	};
}

function fnv1aHex(string) {
	let fnv1a32 = 0x811c9dc5;
	for (let i = 0; i < string.length; ++i) {
		let byte = string.charCodeAt(i);
		fnv1a32 = ((fnv1a32^byte)*0x1000193)|0;
	}
	return [24, 16, 8, 0].map(s => ((fnv1a32>>s)&0xFF).toString(16).padStart(2, "0")).join("");
}

export default async function getWclap(options) {
	if (typeof options === 'string') options = {url: options};
	options = Object.assign({}, options);
	let externalFile = options.externalFile;
	delete options.externalFile;
	let shareFiles = options.shareFiles === true
		&& globalThis.crossOriginIsolated
		&& typeof SharedArrayBuffer === "function";
	delete options.shareFiles;
	let bundleBytes = options.bundleBytes ?? Number.MAX_SAFE_INTEGER;
	let pluginMemoryBytes = options.pluginMemoryBytes
		?? maximumMemoryPages*wasmPageBytes;
	let hintedPluginMemoryBytes = options.hintedPluginMemoryBytes ?? pluginMemoryBytes;
	if (!Number.isSafeInteger(bundleBytes) || bundleBytes < wasmPageBytes)
		throw new RangeError(`bundleBytes must be an integer of at least ${wasmPageBytes} bytes`);
	if (!Number.isSafeInteger(pluginMemoryBytes) || pluginMemoryBytes < wasmPageBytes)
		throw new RangeError(`pluginMemoryBytes must be an integer of at least ${wasmPageBytes} bytes`);
	if (!Number.isSafeInteger(hintedPluginMemoryBytes) || hintedPluginMemoryBytes < wasmPageBytes)
		throw new RangeError(`hintedPluginMemoryBytes must be an integer of at least ${wasmPageBytes} bytes`);
	if (!options.pluginPath) options.pluginPath = "/plugin/" + fnv1aHex(options.url);
	if (options.module && options.module instanceof WebAssembly.Module) {
		// Make a distinct copy of the memory (if it exists)
		if (options.memory) options.memory = new WebAssembly.Memory(options.memorySpec);
		// Distinct path suffix
		options.pluginPath += "-copy-" + fnv1aHex(Date.now() + options.url + Math.random());
		return options;
	}

	let prevFiles = options.files;
	options.files = {};
	let suppliedBytes = 0;
	if (prevFiles) {
		for (let key in prevFiles) { // Add the WCLAP's path prefix
			let {path, value} = checkedFile(key, prevFiles[key]);
			suppliedBytes += value.byteLength;
			if (suppliedBytes > bundleBytes)
				throw bundleLimitError(bundleBytes, suppliedBytes, "host-supplied files");
			const fullPath = `${options.pluginPath}/${path}`;
			if (Object.hasOwn(options.files, fullPath))
				throw codedError("invalid-archive", `Duplicate WCLAP file path: ${path}`);
			options.files[fullPath] = sharedFile(value,
				shareFiles && !/(^|\/)module\.wasm$/.test(path));
		}
	}

	function guessMemorySize(bufferOrSize, module, hints = null) {
		const memoryLimitBytes = hints ? hintedPluginMemoryBytes : pluginMemoryBytes;
		const pluginMaximumPages = Math.floor(memoryLimitBytes/wasmPageBytes);
		let importsMemory = false;
		WebAssembly.Module.imports(module).forEach(entry => {
			if (entry.kind == 'memory') importsMemory = true;
		});
		if (!importsMemory) return;
	
		// We have to guess the imported memory size - as a heuristic, use the module size itself
		let declaration = typeof bufferOrSize === "number"
			? null : importedMemoryLimits(bufferOrSize);
		let moduleSize = (typeof bufferOrSize == 'number' ? bufferOrSize : bufferOrSize.byteLength);
		let modulePages = declaration
			? Math.max(declaration.minimumPages, 4)
			: Math.max(Math.ceil(moduleSize/wasmPageBytes) || 4, 4);
		if (hints) modulePages = Math.max(modulePages,
			Math.ceil(hints.minimumBytes/wasmPageBytes));
		if (modulePages > pluginMaximumPages) {
			const requiredBytes = modulePages*wasmPageBytes;
			throw codedError("plugin-memory-limit",
				`The WCLAP module requires at least ${modulePages*wasmPageBytes} bytes, above the ${memoryLimitBytes}-byte plug-in memory limit`, {
					stage: "module memory", limitBytes: memoryLimitBytes,
					requiredBytes, retryable: true,
					suggestedLimits: hints
						? {hintedPluginMemoryBytes: requiredBytes}
						: {pluginMemoryBytes: requiredBytes},
				});
		}
		let maximumPages = Math.min(pluginMaximumPages,
			declaration?.maximumPages ?? pluginMaximumPages,
			hints ? Math.floor(hints.recommendedMaximumBytes/wasmPageBytes) : pluginMaximumPages);
		let initialPages = Math.max(modulePages,
			hints ? Math.ceil(hints.recommendedInitialBytes/wasmPageBytes) : modulePages);
		if (initialPages > maximumPages) {
			throw codedError("invalid-archive",
				"memory.json recommendations conflict with the module memory declaration", {
					stage: "module memory", requiredBytes: initialPages*wasmPageBytes,
				});
		}
		options.memorySpec = {
			initial: initialPages,
			maximum: maximumPages,
			shared: true,
		};
		// If we're cross-origin isolated, actually create this memory
		if (globalThis.crossOriginIsolated && !options.deferMemory)
			options.memory = new WebAssembly.Memory(options.memorySpec);
	}

	let wasmPath = `${options.pluginPath}/module.wasm`;
	const moduleFromFiles = !options.module && Boolean(options.files[wasmPath]);
	options.module = options.module || options.files[wasmPath];
	options.files[wasmPath] = new ArrayBuffer(0); // avoid self-parsing shenanigans

	if (options.module && (options.module instanceof ArrayBuffer || ArrayBuffer.isView(options.module))) {
		let buffer = options.module;
		const observedBytes = suppliedBytes + (moduleFromFiles ? 0 : buffer.byteLength);
		if (observedBytes > bundleBytes) {
			throw bundleLimitError(
				bundleBytes, observedBytes, "source and host-supplied files");
		}
		options.module = await WebAssembly.compile(buffer);
		guessMemorySize(buffer, options.module, memoryHints(options.files));
		options.resourceMemorySpec = resourceMemorySpec(options.files).memorySpec;
		return options;
	}

	let response = boundedResponse(await fetch(options.url), bundleBytes, suppliedBytes);
	let contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType == "application/wasm") {
		let buffer = await response.arrayBuffer();
		options.module = await WebAssembly.compile(buffer);
		guessMemorySize(buffer, options.module);
		options.resourceMemorySpec = resourceMemorySpec(options.files).memorySpec;
		return options;
	}
	if (new URL(response.url || options.url).pathname.toLowerCase().endsWith(".wasm")) {
		let buffer = await response.arrayBuffer();
		options.module = await WebAssembly.compile(buffer);
		guessMemorySize(buffer, options.module);
		options.resourceMemorySpec = resourceMemorySpec(options.files).memorySpec;
		return options;
	}

	// If it's not WASM, assume it's a `.tar.gz`
	let expanded = await expandTarGz(
		response, bundleBytes, suppliedBytes, shareFiles, externalFile);
	let tarFiles = expanded.files;
	for (let path in tarFiles) {
		options.files[`${options.pluginPath}/${path}`] = tarFiles[path];
	}
	if (!options.files[wasmPath] || !options.files[wasmPath].byteLength) {
		// Find first `module.wasm` in the bundle (in case it's not top-level)
		for (let path in tarFiles) {
			let normalizedPath = path.replace(/^(\.\/)+/, "");
			if (/(^|\/)module\.wasm$/.test(normalizedPath)) {
				console.error(`WCLAP bundle has WASM at ${path} instead of /module.wasm`);
				wasmPath = `${options.pluginPath}/${normalizedPath}`;
				break;
			}
		}
	}
	if (!options.files[wasmPath] || !options.files[wasmPath].byteLength) {
		throw Error("No `module.wasm` found in WCLAP bundle");
	}

	options.module = await WebAssembly.compile(options.files[wasmPath]);
	guessMemorySize(options.files[wasmPath], options.module, memoryHints(options.files));
	options.files[wasmPath] = new ArrayBuffer(0);
	if (expanded.externalFiles.length) {
		options.hostFiles = expanded.externalFiles.map((file, id) => ({
			...file, id, path: `${options.pluginPath}/${file.path}`,
		}));
	}
	options.resourceMemorySpec = resourceMemorySpec(options.files).memorySpec;

	return options;
}
