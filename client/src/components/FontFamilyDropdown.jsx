import DropdownWrapper from './DropdownWrapper';
import './FontFamilyDropdown.css';

export default function FontFamilyDropdown({ editor }) {

  const systemFonts = [
    { label: 'Sans Serif', value: 'Arial, sans-serif' },
    { label: 'Serif', value: 'Georgia, serif' },
    { label: 'Monospace', value: 'Courier New, monospace' },
    { label: 'Times New Roman', value: 'Times New Roman, serif' },
    { label: 'Verdana', value: 'Verdana, sans-serif' },
    { label: 'Comic Sans', value: 'Comic Sans MS, cursive' },
    { label: 'Impact', value: 'Impact, fantasy' },
  ];

  const currentFontFamily = editor.getAttributes('textStyle').fontFamily;
  const currentLabel = systemFonts.find(f => f.value === currentFontFamily)?.label || 'Sans Serif';

  const handleSelect = (font, close) => {
    editor.chain().focus().setFontFamily(font.value).run();
    close();
  };

  const handleUnset = (close) => {
    editor.chain().focus().unsetFontFamily().run();
    close();
  };

  return (
    <DropdownWrapper
      className="font-family-dropdown"
      trigger={() => (
        <button
          className="toolbar-button toolbar-dropdown-button"
          title="Font Family"
        >
          {currentLabel} ▾
        </button>
      )}
    >
      {(close) => (
        <div className="dropdown-menu">
          {systemFonts.map(font => (
            <div
              key={font.value}
              className="dropdown-item"
              onClick={() => handleSelect(font, close)}
              style={{ fontFamily: font.value }}
            >
              {font.label}
            </div>
          ))}
          <div className="dropdown-divider"></div>
          <div
            className="dropdown-item"
            onClick={() => handleUnset(close)}
          >
            Reset to default
          </div>
        </div>
      )}
    </DropdownWrapper>
  );
}
