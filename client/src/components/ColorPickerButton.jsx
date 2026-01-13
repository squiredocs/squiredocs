import DropdownWrapper from './DropdownWrapper';
import ColorPicker from './ColorPicker';

export default function ColorPickerButton({ editor, type, className = '' }) {
  const isText = type === 'text';
  const isActive = isText
    ? editor.isActive('textStyle', { color: /.+/ })
    : editor.isActive('textStyle', { backgroundColor: /.+/ });

  return (
    <DropdownWrapper
      trigger={(isOpen) => (
        <button
          className={`toolbar-button ${isActive ? 'is-active' : ''} ${isOpen ? 'is-open' : ''}`}
          title={isText ? 'Text Color' : 'Background Color'}
        >
          {isText ? (
            'A'
          ) : (
            <span style={{ backgroundColor: '#fff3cd', padding: '2px 4px' }}>A</span>
          )}
        </button>
      )}
    >
      {(close) => (
        <ColorPicker
          editor={editor}
          type={type}
          onClose={close}
        />
      )}
    </DropdownWrapper>
  );
}
