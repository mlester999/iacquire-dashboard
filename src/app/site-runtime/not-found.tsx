// Shown for any host or page that isn't a live, verified site. It deliberately says nothing about who might own the address.
export default function SiteNotFound() {
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "2rem", fontFamily: "ui-sans-serif, system-ui, sans-serif", textAlign: "center", background: "#f8f9fb", color: "#101828" }}>
      <div>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0 }}>This page isn&apos;t available</h1>
        <p style={{ marginTop: ".75rem", color: "#475467" }}>The address may be mistyped, or the site may be offline.</p>
      </div>
    </main>
  );
}
