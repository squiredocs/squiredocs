export function getGreeting(name) {
  const h = new Date().getHours();
  const timeOfDay = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = name?.split(' ')[0];
  return firstName ? `${timeOfDay}, ${firstName}` : timeOfDay;
}
