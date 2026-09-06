// A dependency-free Wayland client speaking just enough of the wire protocol
// to drive zwlr_virtual_pointer_v1: absolute motion and buttons. niri
// implements the protocol natively (its own virtual_pointer.rs), and the
// packaged alternative, ydotool, runs a relative-only uinput device, so this
// client is what makes pixel-accurate clicking possible.
//
// Wire format: every message is an 8-byte header (object id, size|opcode)
// followed by arguments padded to 4-byte multiples. Strings are a length word
// including the trailing NUL, then the bytes plus padding. Fixed-point is
// signed 24.8. Object ids are client-chosen and monotonic. The only events
// handled are wl_registry.global, wl_callback.done, and wl_display.error;
// everything else (delete_id included) is dropped.
import net from "node:net";

import { waylandSocketPath } from "./env.js";

/** @module dsh-plugin-computer-use/wayland-pointer */

export const BTN_LEFT = 0x110;
export const BTN_RIGHT = 0x111;
export const BTN_MIDDLE = 0x112;

const OP = {
	// wl_display requests / events
	displaySync: 0,
	displayGetRegistry: 1,
	displayError: 0,
	// wl_registry
	registryBind: 0,
	registryGlobal: 0,
	// wl_callback
	callbackDone: 0,
	// zwlr_virtual_pointer_manager_v1 (declaration order in wlr-virtual-pointer-unstable-v1.xml)
	managerCreateVirtualPointer: 0,
	managerDestroy: 1,
	// zwlr_virtual_pointer_v1
	pointerMotionAbsolute: 1,
	pointerButton: 2,
	pointerFrame: 4,
	pointerDestroy: 8,
};

const MANAGER_INTERFACE = "zwlr_virtual_pointer_manager_v1";

function u32(value) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value >>> 0, 0);
	return buffer;
}

function message(objectId, opcode, ...parts) {
	const body = Buffer.concat(parts);
	const header = Buffer.alloc(8);
	header.writeUInt32LE(objectId, 0);
	header.writeUInt32LE(((body.length + 8) << 16) | opcode, 4);
	return Buffer.concat([header, body]);
}

function wireString(value) {
	const body = Buffer.from(value, "utf8");
	const padded = Buffer.alloc(Math.ceil((body.length + 1) / 4) * 4);
	body.copy(padded);
	padded.writeUInt8(0, body.length);
	const length = Buffer.alloc(4);
	length.writeUInt32LE(body.length + 1, 0);
	return Buffer.concat([length, padded]);
}

/** One Wayland connection; see the module comment for the protocol scope. */
export class VirtualPointer {
	#socketPath;
	#socket = null;
	#buffer = Buffer.alloc(0);
	#nextId = 1;
	#sinks = new Map();
	#error = null;
	#managerId = 0;
	#pointerId = 0;
	#serial = 0;

	constructor(socketPath = undefined) {
		this.#socketPath = socketPath;
	}

	#allocate() {
		return ++this.#nextId;
	}

	#send(...parts) {
		this.#socket?.write(Buffer.concat(parts));
	}

	/** Attach a persistent per-object event sink; returns a detach function. */
	#addSink(objectId, handler) {
		this.#sinks.set(objectId, handler);
		return () => this.#sinks.delete(objectId);
	}

	/** Resolve on the next event matching object id (and opcode when given). */
	#waitEvent(objectId, opcode = undefined) {
		return new Promise((resolve, reject) => {
			const detach = this.#addSink(objectId, (seenOpcode, body) => {
				detach();
				if (opcode === undefined || seenOpcode === opcode) resolve(body);
				else reject(new Error(`unexpected opcode ${seenOpcode} on object ${objectId}`));
			});
		});
	}

	#dispatch(header, body) {
		const objectId = header.readUInt32LE(0);
		const opcode = header.readUInt32LE(4) & 0xffff;

		if (objectId === 1 && opcode === OP.displayError) {
			const code = body.readUInt32LE(4);
			const length = body.readUInt32LE(8);
			const text = body.toString("utf8", 12, 12 + Math.max(0, length - 1));
			this.#error = new Error(`wayland display error (code ${code}): ${text}`);
			for (const handler of [...this.#sinks.values()]) handler(opcode, body, true);
			return;
		}

		const handler = this.#sinks.get(objectId);
		if (handler !== undefined) handler(opcode, body, false);
	}

	#pump() {
		while (this.#buffer.length >= 8) {
			const size = this.#buffer.readUInt32LE(4) >>> 16;
			if (size < 8) break;
			if (this.#buffer.length < size) return;
			const header = Buffer.from(this.#buffer.subarray(0, 8));
			const body = Buffer.from(this.#buffer.subarray(8, size));
			this.#buffer = this.#buffer.subarray(size);
			this.#dispatch(header, body);
		}
	}

	async #roundtrip() {
		const callbackId = this.#allocate();
		const done = this.#waitEvent(callbackId, OP.callbackDone);
		this.#send(message(1, OP.displaySync, u32(callbackId)));
		await done;
	}

	/** Connect, bind the manager global, and create the virtual pointer. */
	async open() {
		const path = this.#socketPath ?? waylandSocketPath();
		if (path === undefined) {
			throw new Error("no Wayland display found: WAYLAND_DISPLAY is unset and no wayland-* socket exists in $XDG_RUNTIME_DIR");
		}

		await new Promise((resolve, reject) => {
			this.#socket = net.connect(path);
			this.#socket.once("connect", resolve);
			this.#socket.once("error", reject);
		});
		this.#socket.on("data", (chunk) => {
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			this.#pump();
		});
		// Late errors reject pending sinks through #dispatch's error path.
		this.#socket.on("error", () => {});

		const registryId = this.#allocate();
		const globals = [];
		this.#addSink(registryId, (opcode, body) => {
			if (opcode !== OP.registryGlobal) return;
			const name = body.readUInt32LE(0);
			const interfaceLength = body.readUInt32LE(4);
			const interfaceName = body.toString("utf8", 8, 8 + Math.max(0, interfaceLength - 1));
			const version = body.readUInt32LE(8 + Math.ceil(interfaceLength / 4) * 4);
			globals.push({ name, interfaceName, version });
		});

		this.#send(message(1, OP.displayGetRegistry, u32(registryId)));
		await this.#roundtrip();
		if (this.#error !== null) throw this.#error;

		const manager = globals.find((global) => global.interfaceName === MANAGER_INTERFACE);
		if (manager === undefined) {
			throw new Error(`${MANAGER_INTERFACE} is not advertised by the compositor; absolute pointer input is unavailable`);
		}

		this.#managerId = this.#allocate();
		const version = Math.min(manager.version, 2);
		this.#send(message(registryId, OP.registryBind, u32(manager.name), wireString(MANAGER_INTERFACE), u32(version), u32(this.#managerId)));

		this.#pointerId = this.#allocate();
		// create_virtual_pointer(seat: nullable object → 0, id: new_id).
		this.#send(message(this.#managerId, OP.managerCreateVirtualPointer, u32(0), u32(this.#pointerId)));
		await this.#roundtrip();
		if (this.#error !== null) throw this.#error;
	}

	#now() {
		this.#serial = (this.#serial + 1) % 0x7fffffff;
		return this.#serial;
	}

	/** Move to desktop-global logical pixel `(x, y)` inside `bounds`. */
	moveAbsolute(x, y, bounds) {
		const localX = Math.min(Math.max(x - bounds.x, 0), Math.max(bounds.width - 1, 0));
		const localY = Math.min(Math.max(y - bounds.y, 0), Math.max(bounds.height - 1, 0));
		this.#send(
			message(
				this.#pointerId,
				OP.pointerMotionAbsolute,
				u32(this.#now()),
				u32(Math.round(localX)),
				u32(Math.round(localY)),
				u32(bounds.width),
				u32(bounds.height),
			),
		);
		this.#send(message(this.#pointerId, OP.pointerFrame));
	}

	/** Press or release a button; `code` is an evdev BTN_* constant. */
	button(code, pressed) {
		this.#send(message(this.#pointerId, OP.pointerButton, u32(this.#now()), u32(code), u32(pressed ? 1 : 0)));
		this.#send(message(this.#pointerId, OP.pointerFrame));
	}

	async close() {
		if (this.#pointerId !== 0) this.#send(message(this.#pointerId, OP.pointerDestroy));
		if (this.#managerId !== 0) this.#send(message(this.#managerId, OP.managerDestroy));
		await new Promise((resolve) => this.#socket?.end(resolve));
		this.#socket?.destroy();
		this.#socket = null;
		this.#sinks.clear();
	}
}

/** Map a button name onto its evdev code. */
export function buttonCode(name) {
	const codes = { left: BTN_LEFT, right: BTN_RIGHT, middle: BTN_MIDDLE };
	const code = codes[String(name).toLowerCase()];
	if (code === undefined) throw new Error(`unknown button "${name}"; use left, right, or middle`);
	return code;
}

/** Open a pointer, run `async (pointer) => ...`, and always close it. */
export async function withVirtualPointer(use, socketPath = undefined) {
	const pointer = new VirtualPointer(socketPath);
	try {
		await pointer.open();
		return await use(pointer);
	} finally {
		await pointer.close().catch(() => {});
	}
}
