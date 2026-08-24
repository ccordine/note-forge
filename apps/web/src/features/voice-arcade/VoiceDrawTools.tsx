import type {
  VoiceDrawBrushStyle,
  VoiceDrawState,
  VoiceDrawTool,
} from "./voice-draw-types";

const CANVAS_SIZE = 1_000;
const PALETTE = Object.freeze([
  "#f5f2df",
  "#ff75d8",
  "#60e8ff",
  "#d8ff3e",
  "#ff6b45",
  "#b39aff",
  "#ffcf5a",
  "#57e389",
]);

interface VoiceDrawToolsProps {
  readonly state: Readonly<VoiceDrawState>;
  readonly configureStyle: (changes: Partial<VoiceDrawBrushStyle>) => void;
  readonly togglePen: () => void;
  readonly undo: () => void;
  readonly clearDrawing: () => void;
  readonly resetCursor: () => void;
}

export function VoiceDrawTools({
  state,
  configureStyle,
  togglePen,
  undo,
  clearDrawing,
  resetCursor,
}: VoiceDrawToolsProps) {
  return (
    <aside className="voice-draw-tools" aria-label="Drawing tools">
      <section className="voice-draw-tool-group">
        <h2>Color</h2>
        <div className="voice-draw-palette">
          {PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              className={`voice-draw-swatch ${state.style.color === color ? "active" : ""}`}
              style={{ backgroundColor: color }}
              aria-label={`Use ${color} brush color`}
              aria-pressed={state.style.color === color}
              onClick={() => configureStyle({ color, tool: "brush" })}
            />
          ))}
        </div>
        <label className="voice-draw-color-input">
          Custom color
          <input
            type="color"
            value={state.style.color}
            aria-label="Custom brush color"
            onChange={(event) => configureStyle({ color: event.target.value, tool: "brush" })}
          />
        </label>
      </section>

      <section className="voice-draw-tool-group">
        <h2>Brush</h2>
        <label className="voice-draw-size">
          <input
            type="range"
            min="0.004"
            max="0.04"
            step="0.002"
            value={state.style.width}
            aria-label="Brush size"
            onChange={(event) => configureStyle({ width: Number(event.target.value) })}
          />
          <output>{Math.round(state.style.width * CANVAS_SIZE)} px</output>
        </label>
        <div className="voice-draw-tool-buttons" role="group" aria-label="Brush tool">
          {(["brush", "eraser"] as const satisfies readonly VoiceDrawTool[]).map((tool) => (
            <button
              key={tool}
              type="button"
              className={state.style.tool === tool ? "active" : ""}
              aria-pressed={state.style.tool === tool}
              onClick={() => configureStyle({ tool })}
            >
              {tool === "brush" ? "Brush" : "Eraser"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`voice-draw-pen-button ${state.penDown ? "active" : ""}`}
          aria-pressed={state.penDown}
          onClick={togglePen}
        >
          {state.penDown ? "Lift pen" : "Lower pen"}
        </button>
      </section>

      <section className="voice-draw-tool-group">
        <h2>History</h2>
        <div className="voice-draw-history-buttons">
          <button type="button" disabled={state.segments.length === 0} onClick={undo}>Undo stroke</button>
          <button type="button" disabled={state.segments.length === 0} onClick={clearDrawing}>Clear</button>
        </div>
        <button
          type="button"
          className="voice-draw-pen-button"
          onClick={resetCursor}
          title="Return the voice cursor to the center without changing the artwork"
        >
          Reset cursor
        </button>
      </section>
    </aside>
  );
}
