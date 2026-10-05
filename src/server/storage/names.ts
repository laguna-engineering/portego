/** The name shown for a user: the one they chose, else the one sign-in recorded. */
export const USER_NAME = `coalesce(userDisplayNames.name, "user".name)`;

/** Makes `USER_NAME` available. It goes after a join on "user". */
export const JOIN_DISPLAY_NAME = `left join userDisplayNames on userDisplayNames.userId = "user".id`;
