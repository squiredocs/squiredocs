import { useState } from 'react';
import './TableMenu.css';

export default function TableMenu({ editor, onClose }) {
  const [hoveredCell, setHoveredCell] = useState({ row: 0, col: 0 });

  const maxRows = 10;
  const maxCols = 10;

  const handleCellHover = (row, col) => {
    setHoveredCell({ row, col });
  };

  const handleCellClick = (rows, cols) => {
    // Insert table with first row as headers
    editor
      .chain()
      .focus()
      .insertTable({ rows, cols, withHeaderRow: true })
      .run();
    onClose();
  };

  return (
    <div className="table-menu">
      <div className="table-menu-header">
        Insert Table: {hoveredCell.row + 1} × {hoveredCell.col + 1}
      </div>
      <div className="table-grid">
        {Array.from({ length: maxRows }).map((_, rowIndex) => (
          <div key={rowIndex} className="table-grid-row">
            {Array.from({ length: maxCols }).map((_, colIndex) => (
              <div
                key={colIndex}
                className={`table-grid-cell ${
                  rowIndex <= hoveredCell.row && colIndex <= hoveredCell.col
                    ? 'highlighted'
                    : ''
                }`}
                onMouseEnter={() => handleCellHover(rowIndex, colIndex)}
                onClick={() => handleCellClick(rowIndex + 1, colIndex + 1)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
