function sourceBytes(source) {
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	if (ArrayBuffer.isView(source))
		return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
	return null;
}

class Reader {
	constructor(bytes, start = 0, end = bytes.length) {
		this.bytes = bytes;
		this.position = start;
		this.end = end;
	}

	byte() {
		if (this.position >= this.end) throw new RangeError("Unexpected end of Wasm module");
		return this.bytes[this.position++];
	}

	unsigned() {
		let result = 0n;
		let shift = 0n;
		for (let index = 0; index < 10; ++index) {
			const byte = this.byte();
			result |= BigInt(byte & 0x7f) << shift;
			if (!(byte & 0x80)) return result;
			shift += 7n;
		}
		throw new RangeError("Invalid Wasm integer");
	}

	count() {
		const value = this.unsigned();
		if (value > BigInt(Number.MAX_SAFE_INTEGER))
			throw new RangeError("Wasm count exceeds JavaScript range");
		return Number(value);
	}

	skipName() {
		const length = this.count();
		this.position += length;
		if (this.position > this.end) throw new RangeError("Invalid Wasm name");
	}

	skipReferenceType() {
		const type = this.byte();
		if (type === 0x63 || type === 0x64) this.unsigned();
	}

	limits() {
		const flags = this.count();
		const minimum = this.unsigned();
		const maximum = flags & 1 ? this.unsigned() : null;
		return {flags, minimum, maximum};
	}
}

function pageCount(value) {
	if (value == null) return null;
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	return Number(value);
}

/** Returns the first imported WebAssembly memory declaration, if readable. */
export function importedMemoryLimits(source) {
	const bytes = sourceBytes(source);
	if (!bytes || bytes.length < 8) return null;
	try {
		if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73
			|| bytes[3] !== 0x6d || bytes[4] !== 1 || bytes[5] || bytes[6] || bytes[7]) {
			return null;
		}
		const module = new Reader(bytes, 8);
		while (module.position < module.end) {
			const sectionId = module.byte();
			const sectionSize = module.count();
			const sectionEnd = module.position + sectionSize;
			if (sectionEnd > module.end) return null;
			if (sectionId !== 2) {
				module.position = sectionEnd;
				continue;
			}

			const imports = new Reader(bytes, module.position, sectionEnd);
			const count = imports.count();
			for (let index = 0; index < count; ++index) {
				imports.skipName();
				imports.skipName();
				switch (imports.byte()) {
					case 0:
						imports.unsigned();
						break;
					case 1:
						imports.skipReferenceType();
						imports.limits();
						break;
					case 2: {
						const declaration = imports.limits();
						const minimumPages = pageCount(declaration.minimum);
						if (minimumPages == null) return null;
						return {
							minimumPages,
							maximumPages: pageCount(declaration.maximum),
							shared: Boolean(declaration.flags & 2),
							memory64: Boolean(declaration.flags & 4),
						};
					}
					case 3:
						imports.skipReferenceType();
						imports.byte();
						break;
					case 4:
						imports.unsigned();
						imports.unsigned();
						break;
					default:
						return null;
				}
			}
			return null;
		}
	} catch {
		return null;
	}
	return null;
}
