import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren, SelectHTMLAttributes } from "react";
import { Icon } from "./Icon";

export function Panel({ children, className = "", ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return <section className={`panel ${className}`} {...props}>{children}</section>;
}

export function Eyebrow({ children }: PropsWithChildren) {
  return <div className="eyebrow">{children}</div>;
}

export function ActionButton({ children, className = "", ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return <button className={`action-button ${className}`} {...props}>{children}</button>;
}

export function PlayButton({ label = "Play", ...props }: { label?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <ActionButton className="play-button" {...props}><span className="play-icon"><Icon name="play" size={16} /></span>{label}</ActionButton>;
}

export function Select({ label, children, ...props }: PropsWithChildren<SelectHTMLAttributes<HTMLSelectElement> & { label: string }>) {
  return (
    <label className="field select-field"><span>{label}</span><span className="select-wrap"><select {...props}>{children}</select><Icon name="chevron" size={15} /></span></label>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented-field">
      {label && <span className="field-label">{label}</span>}
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>{option.label}</button>
        ))}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="switch-row"><span>{label}</span><button type="button" role="switch" aria-checked={checked} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><span /></button></label>
  );
}
