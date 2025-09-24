export default function Overlays({ hindiLine, textOptions }) {
  return (
    <div className="ui-overlays">
      {hindiLine && (
        <div className="hindi-overlay">
          <p>{hindiLine}</p>
        </div>
      )}
      {textOptions && (
        <div className="text-options-overlay">
          {textOptions.map((option) => (
            <div key={option.label} className="text-option">
              <span className="label">{option.label}.</span>
              <span className="text">{option.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}