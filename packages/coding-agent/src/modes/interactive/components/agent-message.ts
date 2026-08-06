import {
	type Component,
	Container,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AgentSessionMessage, formatAgentMessageParticipant } from "../../../core/agent-messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

function collapseText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

class AgentMessageBodyComponent implements Component {
	constructor(private readonly message: string) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const textWidth = Math.max(1, safeWidth - 4);
		const bodyLines = this.message.split("\n").flatMap((line) => {
			const wrapped = wrapTextWithAnsi(line, textWidth);
			return wrapped.length > 0 ? wrapped : [""];
		});
		return bodyLines.map((line, index) => {
			const prefix = index === 0 ? theme.fg("dim", "╰─ ") : "   ";
			return truncateToWidth(` ${prefix}${theme.fg("customMessageText", line)}`, safeWidth, "");
		});
	}

	invalidate(): void {}
}

export class AgentMessageComponent extends Container {
	private readonly content = new Container();
	private readonly header = new Text("", 1, 0);
	private expanded = false;

	constructor(
		private readonly message: AgentSessionMessage,
		_markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options: { suppressLeadingSpace?: boolean } = {},
	) {
		super();
		if (!options.suppressLeadingSpace) this.addChild(new Spacer(1));
		this.addChild(this.content);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.content.clear();
		this.header.setText(this.headerText());
		this.content.addChild(this.header);
		if (this.expanded) {
			this.content.addChild(new AgentMessageBodyComponent(this.message.details.message));
		}
	}

	private headerText(): string {
		const icon = theme.fg("accent", "◆");
		const title = theme.fg("muted", "Agent message received");
		const participant = formatAgentMessageParticipant(
			"received",
			this.message.details.fromRelationship,
			this.message.details.from,
		);
		const sender = theme.fg("muted", participant);
		const separator = theme.fg("dim", " · ");
		if (this.expanded) {
			return `${icon} ${title}${separator}${sender}`;
		}

		const prefixWidth = visibleWidth(`◆ Agent message received · ${participant} · `);
		const preview = truncateToWidth(collapseText(this.message.details.message), Math.max(20, 100 - prefixWidth));
		const hint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
		return `${icon} ${title}${separator}${sender}${separator}${theme.fg("muted", preview)}${hint}`;
	}
}
