import {
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../Icon";

export interface WorkflowStep {
  id: string;
  label: string;
  detail?: string;
}

interface WorkflowProgressProps {
  steps: readonly WorkflowStep[];
  activeStep: number;
  label?: string;
}

export function WorkflowProgress({ steps, activeStep, label = "Workflow progress" }: WorkflowProgressProps) {
  return (
    <ol className="nf-workflow-progress" aria-label={label}>
      {steps.map((step, index) => (
        <li
          key={step.id}
          className={index === activeStep ? "current" : index < activeStep ? "complete" : "pending"}
          aria-current={index === activeStep ? "step" : undefined}
        >
          <span>{index < activeStep ? "✓" : index + 1}</span>
          <div><b>{step.label}</b>{step.detail && <small>{step.detail}</small>}</div>
        </li>
      ))}
    </ol>
  );
}

interface WorkflowStageProps extends PropsWithChildren<Omit<HTMLAttributes<HTMLElement>, "title">> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  /** Disable announcement when a workflow supplies its own debounced live region. */
  statusLive?: boolean;
  actions?: ReactNode;
}

/**
 * One mutually-exclusive workflow stage. Parent state chooses exactly one
 * instance; future and completed stage bodies are not mounted beside it.
 */
export function WorkflowStage({
  eyebrow,
  title,
  description,
  status,
  statusLive = true,
  actions,
  children,
  className = "",
  ...props
}: WorkflowStageProps) {
  const titleId = useId();
  const eyebrowId = useId();
  return (
    <section className={`nf-workflow-stage ${className}`.trim()} aria-labelledby={titleId} {...props}>
      <header className="nf-workflow-stage__header">
        <div>
          {eyebrow && <span id={eyebrowId} className="nf-workflow-stage__eyebrow">{eyebrow}</span>}
          <h2
            id={titleId}
            data-workflow-stage-title
            tabIndex={-1}
            aria-describedby={eyebrow ? eyebrowId : undefined}
          >{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {status && (
          <div
            className="nf-workflow-stage__status"
            role={statusLive ? "status" : undefined}
            aria-live={statusLive ? "polite" : undefined}
          >
            {status}
          </div>
        )}
      </header>
      <div className="nf-workflow-stage__body">{children}</div>
      {actions && <footer className="nf-workflow-stage__actions">{actions}</footer>}
    </section>
  );
}

interface WorkflowDialogProps extends PropsWithChildren {
  open: boolean;
  steps: readonly WorkflowStep[];
  activeStep: number;
  /** Changes focus/announce the newly mounted stage even within one progress step. */
  focusKey?: string | number;
  label: string;
  onExit: () => void;
  exitLabel?: string;
  className?: string;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Modal shell shared by coached lessons, assessments, and games. */
export function WorkflowDialog({
  open,
  steps,
  activeStep,
  focusKey = activeStep,
  label,
  onExit,
  exitLabel = "Stop workflow",
  className = "",
  children,
}: WorkflowDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const currentStageRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnFocusFrameRef = useRef<number | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    if (!open) return undefined;
    if (returnFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(returnFocusFrameRef.current);
      returnFocusFrameRef.current = null;
    }
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    const priorOverflow = document.body.style.overflow;
    const priorInert = root?.inert ?? false;
    document.body.style.overflow = "hidden";
    if (root) root.inert = true;
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onExitRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = priorOverflow;
      if (root) root.inert = priorInert;
      returnFocusFrameRef.current = window.requestAnimationFrame(() => {
        returnFocusFrameRef.current = null;
        returnFocusRef.current?.focus({ preventScroll: true });
      });
    };
  }, [open]);

  useEffect(() => () => {
    if (returnFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(returnFocusFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const focusFrame = window.requestAnimationFrame(() => {
      const stageTitle = currentStageRef.current?.querySelector<HTMLElement>("[data-workflow-stage-title]");
      (stageTitle ?? currentStageRef.current)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [activeStep, focusKey, open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="nf-workflow-backdrop">
      <section
        ref={dialogRef}
        className={`nf-workflow-dialog ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <header className="nf-workflow-dialog__chrome">
          <WorkflowProgress steps={steps} activeStep={activeStep} />
          <button type="button" className="nf-workflow-dialog__exit" onClick={onExit}>
            <Icon name="pause" size={16} /> {exitLabel}
          </button>
        </header>
        <div
          ref={currentStageRef}
          className="nf-workflow-dialog__current-stage"
          data-active-step={steps[activeStep]?.id ?? "unknown"}
          aria-label={`${steps[activeStep]?.label ?? "Current"} step`}
          tabIndex={-1}
        >
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}
