import './UserList.css';

export default function UserList({ users, currentUserId }) {
  return (
    <div className="user-list">
      <h3 className="user-list-title">Online Users ({users.length})</h3>
      {users.length === 0 ? (
        <div className="user-list-empty">No users online</div>
      ) : (
        <ul className="user-list-items">
          {users.map((user) => (
            <li 
              key={user.id} 
              className={`user-list-item ${user.id === currentUserId ? 'user-list-item-current' : ''}`}
            >
              {user.picture ? (
                <img 
                  src={user.picture} 
                  alt={user.name}
                  className="user-list-avatar"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span
                  className="user-list-color"
                  style={{ backgroundColor: user.color }}
                />
              )}
              <span className="user-list-name">
                {user.name}
                {user.id === currentUserId && <span className="user-list-you"> (you)</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
