import type { ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out.push(<code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code>);
    else out.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```[^\n]*\n?/);
  return (
    <div className="md">
      {parts.map((part, i) => {
        if (i % 2 === 1) return <pre key={i}>{part.replace(/\n$/, "")}</pre>;
        const body = part.trim();
        if (!body) return null;
        return body.split(/\n{2,}/).map((para, j) => (
          <p key={`${i}-${j}`}>
            {para.split("\n").map((line, k, arr) => (
              <span key={k}>
                {inline(line.replace(/^#{1,6}\s+/, "").replace(/^\s*[*-]\s+/, "• "), `${i}-${j}-${k}`)}
                {k < arr.length - 1 && <br />}
              </span>
            ))}
          </p>
        ));
      })}
    </div>
  );
}
