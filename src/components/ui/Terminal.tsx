import "./ui.css";

export type TerminalLineKind = "info" | "rx" | "tx" | "ok" | "plain";

export interface TerminalLine {
  kind?: TerminalLineKind;
  prefix?: string;
  text: string;
}

export interface TerminalProps {
  lines: TerminalLine[];
  className?: string;
}

export function Terminal({ lines, className = "" }: TerminalProps) {
  return (
    <div className={`rivet-terminal ${className}`.trim()}>
      {lines.map((line, index) => {
        const kind = line.kind ?? "plain";
        return (
          <div key={index}>
            {line.prefix && (
              <span className={kind === "plain" ? undefined : `rivet-terminal-${kind}`}>
                {line.prefix}
              </span>
            )}
            {line.prefix ? " " : ""}
            {line.text}
          </div>
        );
      })}
    </div>
  );
}
