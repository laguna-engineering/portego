/** The user's uploaded picture, or the first letter of their email when they have none. */
export function Avatar({
  email,
  src,
  size = "2rem",
}: {
  email: string;
  src: string | null;
  size?: string;
}) {
  const initial = email.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: `calc(${size} * 0.44)` }}
    >
      {src ? <img src={src} alt="" /> : initial}
    </span>
  );
}
