import { useState, useEffect } from 'react';
import './FontSizeControl.css';

export default function FontSizeControl({ editor }) {
  const [size, setSize] = useState(16);

  useEffect(() => {
    const currentSize = editor.getAttributes('textStyle').fontSize;
    if (currentSize) {
      // Remove 'px' suffix if present
      const numericSize = parseInt(currentSize.replace('px', ''));
      if (!isNaN(numericSize)) {
        setSize(numericSize);
      }
    } else {
      setSize(16); // Default size
    }
  }, [editor.state.selection]);

  const handleChange = (newSize) => {
    const validSize = Math.max(8, Math.min(72, newSize)); // Clamp 8-72px
    setSize(validSize);
    editor.chain().focus().setFontSize(`${validSize}px`).run();
  };

  const handleInputChange = (e) => {
    const value = parseInt(e.target.value);
    if (!isNaN(value)) {
      handleChange(value);
    }
  };

  const handleIncrement = () => {
    handleChange(size + 1);
  };

  const handleDecrement = () => {
    handleChange(size - 1);
  };

  return (
    <div className="font-size-control">
      <button
        className="font-size-button"
        onClick={handleDecrement}
        title="Decrease font size"
      >
        −
      </button>
      <input
        type="number"
        className="font-size-input"
        value={size}
        onChange={handleInputChange}
        min="8"
        max="72"
        title="Font size (px)"
      />
      <button
        className="font-size-button"
        onClick={handleIncrement}
        title="Increase font size"
      >
        +
      </button>
    </div>
  );
}
