"use client";

import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

export function CodeBlock({ code, lang = "json" }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    codeToHtml(code, { lang, theme: "github-dark-default" })
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  if (html === null) {
    return (
      <pre className="code-scroll h-[32rem] max-h-[60vh] overflow-auto rounded-md border border-border bg-black/50 p-3 font-mono text-xs">
        {code}
      </pre>
    );
  }
  return (
    <div
      className="code-scroll h-[32rem] max-h-[60vh] overflow-auto rounded-md border border-border text-xs [&_pre]:m-0 [&_pre]:min-h-full [&_pre]:bg-black/50! [&_pre]:p-4"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
