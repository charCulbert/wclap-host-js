export {expandTarGz as default};

const blockBytes = 512;

function decode(bytes) {
	return new TextDecoder().decode(bytes);
}

function archiveError(message) {
	let error = new Error(message);
	error.code = "invalid-archive";
	return error;
}

function bundleLimitError(limitBytes, observedBytes, stage,
	requiredBytes = observedBytes) {
	let error = new RangeError(
		`WCLAP ${stage} exceeded the ${limitBytes}-byte bundle limit`);
	error.code = "bundle-limit";
	error.stage = stage;
	error.limitBytes = limitBytes;
	error.observedBytes = observedBytes;
	error.requiredBytes = requiredBytes;
	error.suggestedLimits = {bundleBytes: requiredBytes};
	return error;
}

function memoryError(byteLength, cause) {
	let error = new RangeError(
		`The browser could not allocate a ${byteLength}-byte WCLAP archive file`,
		{cause});
	error.code = "memory-unavailable";
	error.stage = "expanded archive file";
	error.requiredBytes = byteLength;
	error.retryable = true;
	return error;
}

function limitedStream(stream, limitBytes, stage, previousBytes = 0) {
	let observedBytes = previousBytes;
	return stream.pipeThrough(new TransformStream({
		transform(chunk, controller) {
			observedBytes += chunk.byteLength;
			if (observedBytes > limitBytes)
				throw bundleLimitError(limitBytes, observedBytes, stage);
			controller.enqueue(chunk);
		},
	}));
}

function normalizeArchivePath(path) {
	if (!path || path.includes("\0") || path.includes("\\")
		|| path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
		throw archiveError(`Invalid WCLAP archive path: ${JSON.stringify(path)}`);
	}
	let parts = [];
	for (let part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..")
			throw archiveError(`WCLAP archive path escapes its root: ${path}`);
		parts.push(part);
	}
	if (!parts.length) throw archiveError(`Invalid WCLAP archive path: ${path}`);
	return parts.join("/");
}

class StreamReader {
	constructor(stream) {
		this.reader = stream.getReader();
		this.chunk = new Uint8Array(0);
		this.offset = 0;
		this.position = 0;
	}

	async nextChunk(allowEnd) {
		while (this.offset === this.chunk.byteLength) {
			let {value, done} = await this.reader.read();
			if (done) {
				if (allowEnd) return false;
				throw archiveError("Truncated WCLAP archive");
			}
			this.chunk = value;
			this.offset = 0;
		}
		return true;
	}

	async read(byteLength, allowEnd = false, shared = false) {
		let output;
		try {
			output = shared && typeof SharedArrayBuffer === "function"
				? new Uint8Array(new SharedArrayBuffer(byteLength))
				: new Uint8Array(byteLength);
		} catch (error) {
			if (error instanceof RangeError) throw memoryError(byteLength, error);
			throw error;
		}

		let written = 0;
		while (written < byteLength) {
			if (!await this.nextChunk(allowEnd && written === 0)) return null;
			let count = Math.min(byteLength - written,
				this.chunk.byteLength - this.offset);
			output.set(this.chunk.subarray(this.offset, this.offset + count), written);
			this.offset += count;
			this.position += count;
			written += count;
		}
		return output;
	}

	async skip(byteLength) {
		while (byteLength > 0) {
			await this.nextChunk(false);
			let count = Math.min(byteLength, this.chunk.byteLength - this.offset);
			this.offset += count;
			this.position += count;
			byteLength -= count;
		}
	}

	async drain() {
		while (await this.nextChunk(true))
			await this.skip(this.chunk.byteLength - this.offset);
	}

	async cancel(reason) {
		try {
			await this.reader.cancel(reason);
		} catch {
		}
	}

	release() {
		this.reader.releaseLock();
	}
}

function tarString(bytes, offset, length) {
	let end = offset;
	while (end < offset + length && bytes[end] !== 0) ++end;
	return decode(bytes.subarray(offset, end));
}

function tarNumber(value, name) {
	let number = typeof value === "number" ? value
		: Number.parseInt(value.trim() || "0", 8);
	if (!Number.isSafeInteger(number) || number < 0)
		throw archiveError(`Invalid WCLAP archive ${name}`);
	return number;
}

function tarHeader(bytes) {
	let name = tarString(bytes, 0, 100);
	let magic = tarString(bytes, 257, 6);
	if (magic.includes("ustar")) {
		let prefix = tarString(bytes, 345, 155);
		if (prefix) name = `${prefix}/${name}`;
	}
	return {
		name,
		size: tarNumber(tarString(bytes, 124, 12), "file size"),
		type: tarString(bytes, 156, 1),
		linkname: tarString(bytes, 157, 100),
	};
}

function parsePax(bytes) {
	let fields = Object.create(null);
	for (let offset = 0; offset < bytes.byteLength;) {
		let space = bytes.indexOf(32, offset);
		if (space < 0) throw archiveError("Invalid WCLAP PAX header");
		let length = Number.parseInt(decode(bytes.subarray(offset, space)), 10);
		if (!Number.isSafeInteger(length) || length <= space - offset + 2
			|| offset + length > bytes.byteLength
			|| bytes[offset + length - 1] !== 10) {
			throw archiveError("Invalid WCLAP PAX header");
		}
		let record = decode(bytes.subarray(space + 1, offset + length - 1));
		let equals = record.indexOf("=");
		if (equals < 1) throw archiveError("Invalid WCLAP PAX header");
		let name = record.slice(0, equals);
		let value = record.slice(equals + 1);
		fields[name] = value === "" ? null
			: name === "size" && /^\d+$/.test(value)
				? Number.parseInt(value, 10) : value;
		offset += length;
	}
	return fields;
}

function applyPax(header, fields) {
	for (let [name, value] of Object.entries(fields)) {
		if (name === "path") name = "name";
		else if (name === "linkpath") name = "linkname";
		if (value === null) delete header[name];
		else header[name] = value;
	}
}

function zeroBlock(bytes) {
	for (let byte of bytes) if (byte !== 0) return false;
	return true;
}

async function expandTarGz(tarResponse, limitBytes = Number.MAX_SAFE_INTEGER,
	previousBytes = 0, sharedFiles = false) {
	if (!tarResponse.body) throw archiveError("WCLAP archive response has no body");
	let stream = tarResponse.body.pipeThrough(new DecompressionStream("gzip"));
	stream = limitedStream(stream, limitBytes, "expanded archive", previousBytes);
	let source = new StreamReader(stream);
	let files = Object.create(null);
	let globalPax = Object.create(null);
	let nextPax = null;

	try {
		for (;;) {
			let block = await source.read(blockBytes, true);
			if (!block) break;
			if (zeroBlock(block)) {
				await source.drain();
				break;
			}

			let header = tarHeader(block);
			let size = header.size;
			let paddedSize = Math.ceil(size / blockBytes) * blockBytes;
			let requiredBytes = previousBytes + source.position + paddedSize;
			if (requiredBytes > limitBytes) {
				throw bundleLimitError(limitBytes, previousBytes + source.position,
					"expanded archive", requiredBytes);
			}
			if (header.type === "g" || header.type === "x") {
				let fields = parsePax(await source.read(size));
				await source.skip(paddedSize - size);
				if (header.type === "g") Object.assign(globalPax, fields);
				else nextPax = fields;
				continue;
			}

			applyPax(header, globalPax);
			if (nextPax) {
				applyPax(header, nextPax);
				nextPax = null;
			}
			size = tarNumber(header.size, "file size");
			paddedSize = Math.ceil(size / blockBytes) * blockBytes;
			requiredBytes = previousBytes + source.position + paddedSize;
			if (requiredBytes > limitBytes) {
				throw bundleLimitError(limitBytes, previousBytes + source.position,
					"expanded archive", requiredBytes);
			}

			if (header.type === "0" || header.type === "") {
				let path = normalizeArchivePath(header.name);
				if (Object.hasOwn(files, path))
					throw archiveError(`Duplicate WCLAP archive path: ${path}`);
				let bytes = await source.read(size, false,
					sharedFiles && !/(^|\/)module\.wasm$/.test(path));
				files[path] = bytes.buffer;
				await source.skip(paddedSize - size);
			} else {
				await source.skip(paddedSize);
			}
		}
		return {files, expandedBytes: source.position};
	} catch (error) {
		await source.cancel(error);
		throw error;
	} finally {
		source.release();
	}
}

// Derived from js-untar by Sebastian Jørgensen.
/*
The MIT License (MIT)

Copyright (c) 2015 Sebastian Jørgensen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
