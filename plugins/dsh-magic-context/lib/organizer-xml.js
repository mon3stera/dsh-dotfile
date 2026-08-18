const EPISODE_TYPES = new Set([
	"design",
	"feature",
	"bug",
	"docs",
	"release",
	"investigation",
	"refactor",
	"infra",
]);

const COMPARTMENT_SECTIONS = [
	"objective",
	"continuity",
	"work_completed",
	"decisions",
	"current_state",
	"verification",
	"open_items",
	"user_constraints",
	"anchors",
];

const SECTION_CHILDREN = Object.freeze({
	work_completed: new Set(["item"]),
	decisions: new Set(["decision"]),
	current_state: new Set(["item"]),
	verification: new Set(["check"]),
	open_items: new Set(["item"]),
	user_constraints: new Set(["constraint"]),
	anchors: new Set(["file", "symbol", "command", "error", "commit", "url"]),
});

const MAX_VALIDATION_ERRORS = 20;
const MAX_INVALID_OUTPUT_CHARS = 12000;

function addError(errors, path, message) {
	if (errors.length < MAX_VALIDATION_ERRORS) errors.push(`${path}: ${message}`);
}

function xmlText(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function unescapeXml(value) {
	return String(value ?? "")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function invalidEntity(value) {
	return /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(value);
}

function parseOpenTag(token, errors) {
	let body = token.slice(1, -1).trim();
	let selfClosing = false;
	if (body.endsWith("/")) {
		selfClosing = true;
		body = body.slice(0, -1).trim();
	}
	const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
	if (!nameMatch) {
		addError(errors, "XML", `invalid opening tag ${token}`);
		return null;
	}

	const name = nameMatch[1];
	const attrs = {};
	let index = name.length;
	while (index < body.length) {
		while (/\s/.test(body[index] ?? "")) index += 1;
		if (index >= body.length) break;
		const attrMatch = body.slice(index).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
		if (!attrMatch) {
			addError(errors, `${name}`, `invalid attribute syntax near ${body.slice(index)}`);
			return null;
		}
		const attrName = attrMatch[1];
		index += attrName.length;
		while (/\s/.test(body[index] ?? "")) index += 1;
		if (body[index] !== "=") {
			addError(errors, `${name}.${attrName}`, "attribute must use name=\"value\"");
			return null;
		}
		index += 1;
		while (/\s/.test(body[index] ?? "")) index += 1;
		const quote = body[index];
		if (quote !== '"' && quote !== "'") {
			addError(errors, `${name}.${attrName}`, "attribute value must be quoted");
			return null;
		}
		index += 1;
		const valueStart = index;
		const valueEnd = body.indexOf(quote, index);
		if (valueEnd === -1) {
			addError(errors, `${name}.${attrName}`, "unterminated attribute value");
			return null;
		}
		const value = body.slice(valueStart, valueEnd);
		if (invalidEntity(value)) addError(errors, `${name}.${attrName}`, "contains an unescaped ampersand");
		if (Object.hasOwn(attrs, attrName)) addError(errors, `${name}.${attrName}`, "duplicate attribute");
		attrs[attrName] = unescapeXml(value);
		index = valueEnd + 1;
	}
	return { name, attrs, selfClosing };
}

function appendText(stack, value, errors) {
	if (value.length === 0) return;
	if (value.includes("<")) addError(errors, "XML", "text contains an unescaped < character");
	if (invalidEntity(value)) addError(errors, "XML", "text contains an unescaped ampersand");
	const current = stack.at(-1);
	if (current) {
		current.text += value;
	} else if (value.trim().length > 0) {
		addError(errors, "XML", "text is outside the document root");
	}
}

function parseXmlDocument(text) {
	const errors = [];
	const roots = [];
	const stack = [];
	const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g;
	let cursor = 0;
	let match;

	while ((match = tokenPattern.exec(text)) !== null) {
		appendText(stack, text.slice(cursor, match.index), errors);
		const token = match[0];
		const tokenStart = match.index;
		cursor = tokenPattern.lastIndex;

		if (token.startsWith("<!--") || token.startsWith("<?")) continue;
		if (token.startsWith("<![CDATA[")) {
			appendText(stack, token.slice(9, -3), errors);
			continue;
		}
		if (token.startsWith("<!")) {
			addError(errors, "XML", "DOCTYPE and other declarations are not allowed");
			continue;
		}
		if (token.startsWith("</")) {
			const closeMatch = token.match(/^<\/\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/);
			if (!closeMatch) {
				addError(errors, "XML", `invalid closing tag ${token}`);
				continue;
			}
			const current = stack.at(-1);
			if (!current) {
				addError(errors, "XML", `closing tag </${closeMatch[1]}> has no opening tag`);
				continue;
			}
			if (current.name !== closeMatch[1]) {
				addError(errors, `${current.name}`, `expected </${current.name}> but found </${closeMatch[1]}>`);
				continue;
			}
			current.end = tokenPattern.lastIndex;
			stack.pop();
			continue;
		}

		const parsed = parseOpenTag(token, errors);
		if (!parsed) continue;
		const node = {
			name: parsed.name,
			attrs: parsed.attrs,
			children: [],
			text: "",
			start: tokenStart,
			end: parsed.selfClosing ? tokenPattern.lastIndex : null,
			selfClosing: parsed.selfClosing,
		};
		const parent = stack.at(-1);
		if (parent) parent.children.push(node);
		else roots.push(node);
		if (!parsed.selfClosing) stack.push(node);
	}

	appendText(stack, text.slice(cursor), errors);
	for (const node of stack) addError(errors, node.name, "unclosed element");
	if (roots.length !== 1) addError(errors, "XML", `expected one root element, found ${roots.length}`);
	return { errors, root: roots[0] };
}

function children(node, name) {
	return node.children.filter((child) => child.name === name);
}

function validateAttributes(node, allowed, path, errors) {
	for (const name of Object.keys(node.attrs)) {
		if (!allowed.has(name)) addError(errors, `${path}@${name}`, "unexpected attribute");
	}
}

function leafText(node, path, errors) {
	if (node.children.length > 0) addError(errors, path, "must contain text only");
	const value = unescapeXml(node.text).trim();
	if (value.length === 0) addError(errors, path, "must not be empty");
	return value;
}

function validateEmptyOrChildren(section, allowed, path, errors) {
	if (section.children.length === 1 && section.children[0].name === "none") {
		const none = section.children[0];
		validateAttributes(none, new Set(), `${path}.none`, errors);
		if (!none.selfClosing || none.text.trim().length > 0) {
			addError(errors, path, "<none/> must be self-closing");
		}
		return;
	}
	if (section.children.length === 0) {
		addError(errors, path, "must contain at least one entry or <none/>");
		return;
	}
	for (const child of section.children) {
		if (!allowed.has(child.name)) {
			addError(errors, `${path}.${child.name}`, "unexpected child element");
			continue;
		}
		validateAttributes(child, child.name === "check" ? new Set(["status"]) : new Set(), `${path}.${child.name}`, errors);
		leafText(child, `${path}.${child.name}`, errors);
	}
}

function validateCompartment(compartment, errors) {
	const path = "compartments.compartment";
	validateAttributes(compartment, new Set(["title", "episode_type"]), path, errors);
	const title = String(compartment.attrs.title ?? "").trim();
	if (title.length === 0) addError(errors, `${path}@title`, "is required");
	const episodeType = String(compartment.attrs.episode_type ?? "").trim();
	if (episodeType.length === 0) {
		addError(errors, `${path}@episode_type`, "is required");
	} else if (!EPISODE_TYPES.has(episodeType)) {
		addError(errors, `${path}@episode_type`, `must be one of ${[...EPISODE_TYPES].join(", ")}`);
	}
	if (compartment.text.trim().length > 0) addError(errors, path, "must contain section elements, not direct text");
	const names = compartment.children.map((child) => child.name);
	if (names.length !== COMPARTMENT_SECTIONS.length || names.some((name, index) => name !== COMPARTMENT_SECTIONS[index])) {
		addError(errors, path, `sections must appear exactly in order: ${COMPARTMENT_SECTIONS.join(", ")}`);
	}
	for (const sectionName of COMPARTMENT_SECTIONS) {
		const section = children(compartment, sectionName)[0];
		if (!section) {
			addError(errors, `${path}.${sectionName}`, "required section is missing");
			continue;
		}
		if (sectionName === "objective" || sectionName === "continuity") {
			validateAttributes(section, new Set(), `${path}.${sectionName}`, errors);
			leafText(section, `${path}.${sectionName}`, errors);
			continue;
		}
		validateEmptyOrChildren(section, SECTION_CHILDREN[sectionName], `${path}.${sectionName}`, errors);
		if (sectionName === "verification") {
			for (const check of children(section, "check")) {
				const status = check.attrs.status;
				if (!["passed", "failed", "unverified"].includes(status)) {
					addError(errors, `${path}.verification.check@status`, "must be passed, failed, or unverified");
				}
			}
		}
	}
}

function parseFacts(factsNode, errors) {
	validateAttributes(factsNode, new Set(), "facts", errors);
	if (factsNode.text.trim().length > 0) addError(errors, "facts", "must contain fact elements, not direct text");
	if (factsNode.children.length === 1 && factsNode.children[0].name === "none") {
		const none = factsNode.children[0];
		validateAttributes(none, new Set(), "facts.none", errors);
		if (!none.selfClosing || none.text.trim().length > 0) addError(errors, "facts", "<none/> must be self-closing");
		return [];
	}
	if (factsNode.children.length === 0) {
		addError(errors, "facts", "must contain facts or <none/>");
		return [];
	}
	const facts = [];
	for (const fact of factsNode.children) {
		if (fact.name !== "fact") {
			addError(errors, `facts.${fact.name}`, "unexpected child element");
			continue;
		}
		validateAttributes(fact, new Set(["importance"]), "facts.fact", errors);
		const rawImportance = fact.attrs.importance;
		const importance = Number(rawImportance);
		if (rawImportance === undefined || !/^\d+(?:\.\d+)?$/.test(rawImportance) || !Number.isFinite(importance) || importance < 0 || importance > 10) {
			addError(errors, "facts.fact@importance", "must be a number from 0 to 10");
		}
		const value = leafText(fact, "facts.fact", errors);
		if (value !== "") facts.push({ text: value, importance: Number.isFinite(importance) ? Math.min(10, Math.max(0, importance)) : 5 });
	}
	return facts;
}

/** Validate the new XML organizer protocol and return its parsed payload. */
export function validateOrganizerOutput(text) {
	if (typeof text !== "string" || text.trim().length === 0) {
		return { ok: false, errors: ["XML: output is empty"] };
	}
	const document = parseXmlDocument(text);
	const errors = [...document.errors];
	const root = document.root;
	if (!root) return { ok: false, errors };
	validateAttributes(root, new Set(), "output", errors);
	if (root.name !== "output") addError(errors, "XML", `root must be <output>, found <${root.name}>`);
	if (root.text.trim().length > 0) addError(errors, "output", "must contain compartments and facts, not direct text");
	const rootNames = root.children.map((child) => child.name);
	if (rootNames.length !== 2 || rootNames[0] !== "compartments" || rootNames[1] !== "facts") {
		addError(errors, "output", "children must be <compartments> followed by <facts>");
	}
	const compartmentsNode = children(root, "compartments")[0];
	const factsNode = children(root, "facts")[0];
	let compartment;
	if (!compartmentsNode) {
		addError(errors, "output.compartments", "required element is missing");
	} else {
		validateAttributes(compartmentsNode, new Set(), "compartments", errors);
		if (compartmentsNode.text.trim().length > 0) addError(errors, "compartments", "must contain <compartment>, not direct text");
		const compartmentNodes = children(compartmentsNode, "compartment");
		if (compartmentNodes.length !== 1) addError(errors, "compartments", "must contain exactly one <compartment>");
		compartment = compartmentNodes[0];
		if (compartment) validateCompartment(compartment, errors);
	}
	let facts = [];
	if (!factsNode) addError(errors, "output.facts", "required element is missing");
	else facts = parseFacts(factsNode, errors);
	if (errors.length > 0 || !compartment) return { ok: false, errors: errors.slice(0, MAX_VALIDATION_ERRORS) };
	return {
		ok: true,
		summary: text.slice(compartment.start, compartment.end).trim(),
		facts,
	};
}

/** Parse valid new XML, while retaining compatibility with the legacy format. */
export function parseOrganizerOutput(text) {
	const validated = validateOrganizerOutput(text);
	if (validated.ok) return { summary: validated.summary, facts: validated.facts };
	const summaryMatch = text.match(/<compacted-summary>([\s\S]*?)<\/compacted-summary>/);
	const summary = summaryMatch ? summaryMatch[1].trim() : text.trim();
	const facts = [];
	const factsMatch = text.match(/<session-facts>([\s\S]*?)<\/session-facts>/);
	if (factsMatch) {
		for (const line of factsMatch[1].split("\n")) {
			const match = line.match(/^\s*[-*]\s*(.+?)(?:\s*\(importance:\s*(\d+(?:\.\d+)?)\))?\s*$/);
			if (match && match[1] !== "(none)") {
				const importance = match[2] === undefined ? 5 : Number.parseFloat(match[2]);
				facts.push({ text: match[1].trim(), importance: Math.min(10, Math.max(0, importance)) });
			}
		}
	}
	return { summary, facts };
}

/** Build a repair prompt that reports exact schema failures to the organizer. */
export function buildOrganizerRepairInstruction(baseInstruction, invalidOutput, errors) {
	const rawOutput = String(invalidOutput ?? "");
	const output = rawOutput.length <= MAX_INVALID_OUTPUT_CHARS
		? rawOutput
		: `${rawOutput.slice(0, MAX_INVALID_OUTPUT_CHARS / 2)}\n... invalid output clipped ...\n${rawOutput.slice(-MAX_INVALID_OUTPUT_CHARS / 2)}`;
	const errorBlock = errors.map((error) => `<error>${xmlText(error)}</error>`).join("\n");
	return [
		baseInstruction,
		"",
		"The previous response failed the XML organizer schema. Regenerate the response now.",
		"Fix every reported validation error. The original raw conversation and reference blocks above remain authoritative.",
		"Return only one corrected <output> document using the exact schema above; do not explain the repair.",
		"<validation_errors>",
		errorBlock || "<error>unknown XML validation failure</error>",
		"</validation_errors>",
		"<invalid_output>",
		xmlText(output),
		"</invalid_output>",
	].join("\n\n");
}
