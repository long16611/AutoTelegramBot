const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

export async function resolveRobloxUsername(input) {
  const username = input.trim().replace(/^@/, '');
  if (!USERNAME_PATTERN.test(username)) {
    return null;
  }

  const response = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    throw new Error(`Roblox username lookup failed with HTTP ${response.status}.`);
  }

  const data = await response.json();
  const user = data.data?.[0];
  if (!user?.id || !user.name) {
    return null;
  }

  let avatarUrl = null;
  try {
    const avatarResponse = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(user.id)}&size=150x150&format=Png&isCircular=false`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (avatarResponse.ok) {
      const avatarData = await avatarResponse.json();
      const avatar = avatarData.data?.[0];
      avatarUrl = avatar?.state === 'Completed' ? avatar.imageUrl ?? null : null;
    }
  } catch (error) {
    console.warn('Roblox avatar preview is unavailable:', error);
  }

  return {
    id: String(user.id),
    username: user.name,
    displayName: user.displayName ?? user.name,
    avatarUrl
  };
}
