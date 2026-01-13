import { useState, useEffect } from 'react';
import './ColorPicker.css';

export default function ColorPicker({ editor, type, onClose }) {
  const [hexValue, setHexValue] = useState('');

  const colorPalette = [
    '#000000', '#444444', '#666666', '#999999', '#CCCCCC', '#EEEEEE', '#F3F3F3', '#FFFFFF',
    '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#9900FF', '#FF00FF',
    '#F4CCCC', '#FCE5CD', '#FFF2CC', '#D9EAD3', '#D0E0E3', '#CFE2F3', '#D9D2E9', '#EAD1DC',
    '#EA9999', '#F9CB9C', '#FFE599', '#B6D7A8', '#A2C4C9', '#9FC5E8', '#B4A7D6', '#D5A6BD',
    '#E06666', '#F6B26B', '#FFD966', '#93C47D', '#76A5AF', '#6FA8DC', '#8E7CC3', '#C27BA0',
    '#CC0000', '#E69138', '#F1C232', '#6AA84F', '#45818E', '#3D85C6', '#674EA7', '#A64D79',
    '#990000', '#B45F06', '#BF9000', '#38761D', '#134F5C', '#0B5394', '#351C75', '#741B47',
    '#660000', '#783F04', '#7F6000', '#274E13', '#0C343D', '#073763', '#20124D', '#4C1130',
  ];

  const currentColor = type === 'text'
    ? editor.getAttributes('textStyle').color
    : editor.getAttributes('textStyle').backgroundColor;

  useEffect(() => {
    if (currentColor) {
      setHexValue(currentColor);
    }
  }, [currentColor]);

  const handleColorSelect = (color) => {
    if (type === 'text') {
      editor.chain().focus().setColor(color).run();
    } else {
      editor.chain().focus().setBackgroundColor(color).run();
    }
    onClose();
  };

  const handleHexChange = (e) => {
    let value = e.target.value;
    // Allow # prefix
    if (!value.startsWith('#')) {
      value = '#' + value;
    }
    setHexValue(value);
  };

  const handleHexApply = () => {
    // Validate hex color
    if (/^#[0-9A-Fa-f]{6}$/.test(hexValue)) {
      handleColorSelect(hexValue);
    }
  };

  const handleRemoveColor = () => {
    if (type === 'text') {
      editor.chain().focus().unsetColor().run();
    } else {
      editor.chain().focus().unsetBackgroundColor().run();
    }
    onClose();
  };

  return (
    <div className="color-picker">
      <div className="color-picker-header">
        <span>{type === 'text' ? 'Text Color' : 'Background Color'}</span>
        <button className="color-picker-close" onClick={onClose}>×</button>
      </div>
      <div className="color-palette">
        {colorPalette.map(color => (
          <div
            key={color}
            className={`color-swatch ${currentColor === color ? 'selected' : ''}`}
            style={{ backgroundColor: color }}
            onClick={() => handleColorSelect(color)}
            title={color}
          />
        ))}
      </div>
      <div className="color-picker-hex">
        <input
          type="text"
          value={hexValue}
          onChange={handleHexChange}
          placeholder="#000000"
          maxLength="7"
        />
        <button onClick={handleHexApply}>Apply</button>
      </div>
      <div className="color-picker-footer">
        <button className="color-picker-remove" onClick={handleRemoveColor}>
          Remove color
        </button>
      </div>
    </div>
  );
}
