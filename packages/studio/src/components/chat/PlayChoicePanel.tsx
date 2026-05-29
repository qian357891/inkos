export function PlayChoicePanel(props: {
  readonly choices: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly isZh: boolean;
  readonly onChoose: (action: string) => void;
}) {
  if (props.choices.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground/60">
        {props.disabled ? (props.isZh ? "推进中…" : "Advancing…") : (props.isZh ? "等待场景给出选项…" : "Waiting for choices…")}
      </div>
    );
  }
  return (
    <div className="shrink-0 border-t border-border/40 px-4 py-3">
      <div className="max-w-3xl mx-auto space-y-2">
        {props.choices.map((choice, i) => (
          <button
            key={`${i}-${choice}`}
            type="button"
            disabled={props.disabled}
            onClick={() => props.onChoose(choice)}
            className="w-full text-left rounded-xl border border-border/40 bg-secondary/30 px-3 py-2 text-sm leading-6 hover:border-primary/40 hover:bg-primary/5 transition-all disabled:opacity-40 disabled:pointer-events-none"
          >
            {choice}
          </button>
        ))}
      </div>
    </div>
  );
}
