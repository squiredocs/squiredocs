import { useState, useEffect, useRef } from 'react';
import './FontSizeControl.css';

export default function FontSizeControl({ editor }) {
  const [size, setSize] = useState(16);
  const [inputValue, setInputValue] = useState('16');
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef(null);

  // Sync from editor when selection changes (but not while user is typing)
  useEffect(() => {
    if (isEditing) return;

    const currentSize = editor.getAttributes('textStyle').fontSize;
    if (currentSize) {
      const numericSize = parseInt(currentSize.replace('px', ''));
      if (!isNaN(numericSize)) {
        setSize(numericSize);
        setInputValue(String(numericSize));
      }
    } else {
      setSize(16);
      setInputValue('16');
    }
  }, [editor.state.selection, isEditing]);

  const applySize = (newSize) => {
    const validSize = Math.max(8, Math.min(72, newSize)); // Clamp 8-72px
    setSize(validSize);
    setInputValue(String(validSize));
    editor.chain().focus().setFontSize(`${validSize}px`).run();
  };

  const handleInputChange = (e) => {
    // Allow free typing - don't validate yet
    setInputValue(e.target.value);
  };

  const handleInputFocus = () => {
    setIsEditing(true);
    // Select all text when focused for easy replacement
    inputRef.current?.select();
  };

  const handleInputBlur = () => {
    setIsEditing(false);
    const value = parseInt(inputValue);
    if (!isNaN(value) && value > 0) {
      applySize(value);
    } else {
      // Reset to current size if invalid
      setInputValue(String(size));
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setInputValue(String(size));
      setIsEditing(false);
      editor.commands.focus();
    }
  };

  const handleIncrement = () => {
    applySize(size + 1);
  };

  const handleDecrement = () => {
    applySize(size - 1);
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
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className="font-size-input"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onBlur={handleInputBlur}
        onKeyDown={handleKeyDown}
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
