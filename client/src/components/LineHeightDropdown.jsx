import DropdownWrapper from './DropdownWrapper';
import './LineHeightDropdown.css';

export default function LineHeightDropdown({ editor }) {

  const lineHeights = [
    { label: 'Single', value: '1.0' },
    { label: '1.15', value: '1.15' },
    { label: '1.5', value: '1.5' },
    { label: 'Double', value: '2.0' },
  ];

  const currentLineHeight = editor.getAttributes('textStyle').lineHeight;
  const currentLabel = lineHeights.find(h => h.value === currentLineHeight)?.label || 'Default';

  const handleSelect = (height, close) => {
    editor.chain().focus().setLineHeight(height.value).run();
    close();
  };

  const handleUnset = (close) => {
    editor.chain().focus().unsetLineHeight().run();
    close();
  };

  return (
    <DropdownWrapper
      className="line-height-dropdown"
      trigger={() => (
        <button
          className="toolbar-button toolbar-dropdown-button"
          title="Line Height"
        >
          {currentLabel} ▾
        </button>
      )}
    >
      {(close) => (
        <div className="dropdown-menu">
          {lineHeights.map(height => (
            <div
              key={height.value}
              className="dropdown-item"
              onClick={() => handleSelect(height, close)}
            >
              {height.label}
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
