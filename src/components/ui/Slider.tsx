import type { CSSProperties, InputHTMLAttributes } from "react";
import "./ui.css";

export function Slider({
  min = 0,
  max = 100,
  value,
  defaultValue = 50,
  style,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  const numericMin = Number(min);
  const numericMax = Number(max);
  const numericValue = Number(value ?? defaultValue);
  const span = numericMax - numericMin || 1;
  const percent = Math.max(0, Math.min(100, ((numericValue - numericMin) / span) * 100));
  const sliderStyle = {
    ...style,
    "--r-slider-fill": `${percent}%`,
  } as CSSProperties;

  return (
    <input
      className="rivet-slider"
      type="range"
      min={min}
      max={max}
      value={value}
      defaultValue={value === undefined ? defaultValue : undefined}
      style={sliderStyle}
      {...props}
    />
  );
}
