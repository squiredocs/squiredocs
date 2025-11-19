import './UserList.css';

export default function UserList({ users }) {
  return (
    <div className="user-list">
      <h3 className="user-list-title">Online Users</h3>
      {users.length === 0 ? (
        <div className="user-list-empty">No other users online</div>
      ) : (
        <ul className="user-list-items">
          {users.map((user) => (
            <li key={user.id} className="user-list-item">
              <span
                className="user-list-color"
                style={{ backgroundColor: user.color }}
              />
              <span className="user-list-name">{user.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

