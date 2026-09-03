// A one-line shell into the bot's computer. Mono, folded by default: it is
// for the gawker who wants to peek at a file, not a terminal replacement.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Terminal } from "iconoir-react";

import { type ComputerExecResult, computerExec } from "../../../api/computer";

interface ComputerConsoleProps {
  slug: string;
}

export function ComputerConsole({ slug }: ComputerConsoleProps) {
  const [command, setCommand] = useState("");
  const [last, setLast] = useState<{
    command: string;
    result: ComputerExecResult;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exec = useMutation({
    mutationKey: ["computer-exec", slug],
    mutationFn: (cmd: string) => computerExec(slug, cmd),
    onSuccess: (result, cmd) => {
      setError(null);
      setLast({ command: cmd, result });
      setCommand("");
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Command failed");
    },
  });

  return (
    <details className="computer-console" data-testid="computer-console">
      <summary className="computer-console-summary">
        <Terminal width={14} height={14} aria-hidden="true" />
        Console
      </summary>
      <form
        className="computer-console-form"
        onSubmit={(e) => {
          e.preventDefault();
          const cmd = command.trim();
          if (!cmd || exec.isPending) return;
          exec.mutate(cmd);
        }}
      >
        <span className="computer-console-prompt" aria-hidden="true">
          $
        </span>
        <input
          className="input computer-console-input"
          aria-label="Command"
          placeholder="ls ~/workspace"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="submit"
          className="btn btn-ghost btn-sm"
          disabled={exec.isPending || command.trim().length === 0}
        >
          Run
        </button>
      </form>
      {error ? <div className="computer-console-error">{error}</div> : null}
      {last ? (
        <pre
          className="computer-console-output"
          data-testid="computer-console-output"
        >
          <span className="computer-console-echo">{`$ ${last.command}`}</span>
          {last.result.stdout ? `\n${last.result.stdout}` : ""}
          {last.result.stderr ? (
            <span className="computer-console-stderr">
              {`\n${last.result.stderr}`}
            </span>
          ) : null}
          {last.result.exitCode !== 0 ? (
            <span className="computer-console-exit">
              {`\nexit ${last.result.exitCode}`}
            </span>
          ) : null}
        </pre>
      ) : null}
    </details>
  );
}
