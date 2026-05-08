import { useState, useRef, useEffect } from "react";

const MODULES = [
  { id: "relay",    name: "Relay",    emoji: "📡", tagline: "Catches every tick!",    detail: "Real-time data from NSE & MCX — validated, stored, always fresh.",         color: "#FF6B6B", bg: "rgba(255,107,107,0.12)", ring: 1, startAngle: 0   },
  { id: "forge",    name: "Forge",    emoji: "🔨", tagline: "Build like Lego!",       detail: "Drag-drop strategy builder. Indicators, logic, exits — zero code needed.",   color: "#FFD93D", bg: "rgba(255,217,61,0.12)",  ring: 1, startAngle: 120 },
  { id: "epoch",    name: "Epoch",    emoji: "⏳", tagline: "Time machine!",           detail: "Simulates years of trades in seconds. Bar-by-bar historical replay.",        color: "#6BCB77", bg: "rgba(107,203,119,0.12)", ring: 1, startAngle: 240 },
  { id: "prism",    name: "Prism",    emoji: "🔬", tagline: "Luck or skill?",          detail: "Walk-forward + Monte Carlo validation. Only real edge gets through.",        color: "#4D96FF", bg: "rgba(77,150,255,0.12)",  ring: 2, startAngle: 60  },
  { id: "sentinel", name: "Sentinel", emoji: "🛡️", tagline: "Never sleeps!",           detail: "Live drawdown limits, position sizing, emergency kill switch. Always on.",   color: "#FF6FC8", bg: "rgba(255,111,200,0.12)", ring: 2, startAngle: 180 },
  { id: "lens",     name: "Lens",     emoji: "📊", tagline: "See everything!",         detail: "P&L curves, Sharpe ratio, win rate. Your live Grafana command center.",      color: "#B39DDB", bg: "rgba(179,157,219,0.12)", ring: 2, startAngle: 300 },
  { id: "phantom",  name: "Phantom",  emoji: "👻", tagline: "Trade without risk!",     detail: "Full paper trading sim with real market conditions. Zero capital at stake.", color: "#80DEEA", bg: "rgba(128,222,234,0.12)", ring: 3, startAngle: 30  },
  { id: "thrust",   name: "Thrust",   emoji: "🚀", tagline: "We have liftoff!",        detail: "Live order execution via Zerodha. Pre-flight checks, then fire.",            color: "#FF9A3C", bg: "rgba(255,154,60,0.12)",  ring: 3, startAngle: 150 },
  { id: "gravity",  name: "Gravity",  emoji: "⚖️", tagline: "Balance is power!",       detail: "Regime-aware capital allocator. Pulls weight toward what performs.",         color: "#A5D6A7", bg: "rgba(165,214,167,0.12)", ring: 3, startAngle: 270 },
];

const RINGS = {
  1: { radius: 115, period: 14 },
  2: { radius: 195, period: 24 },
  3: { radius: 278, period: 36 },
};

const W = 640, H = 640;

const STARS = Array.from({ length: 160 }, (_, i) => ({
  id: i,
  cx: Math.random() * W,
  cy: Math.random() * H,
  r: Math.random() * 1.4 + 0.2,
  dur: 1.5 + Math.random() * 2.5,
  delay: Math.random() * 4,
}));

const css = `
  @keyframes twinkle { 0%,100%{opacity:0.15} 50%{opacity:0.9} }
  @keyframes pulse-core { 0%,100%{opacity:1;filter:blur(0px)} 50%{opacity:0.8;filter:blur(1px)} }
  @keyframes ring-glow { 0%,100%{opacity:0.12} 50%{opacity:0.28} }
  @keyframes float-badge { 0%,100%{transform:translateY(0px)} 50%{transform:translateY(-3px)} }
  @keyframes tip-in { from{opacity:0;transform:scale(0.9) translate(-50%,-50%)} to{opacity:1;transform:scale(1) translate(-50%,-50%)} }
  @keyframes center-breathe { 0%,100%{transform:translate(-50%,-50%) scale(1)} 50%{transform:translate(-50%,-50%) scale(1.04)} }
  @keyframes orbit1 { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes orbit2 { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes orbit3 { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes counter1 { from{transform:translateX(115px) translateY(-50%) rotate(0deg)} to{transform:translateX(115px) translateY(-50%) rotate(-360deg)} }
  @keyframes counter2 { from{transform:translateX(195px) translateY(-50%) rotate(0deg)} to{transform:translateX(195px) translateY(-50%) rotate(-360deg)} }
  @keyframes counter3 { from{transform:translateX(278px) translateY(-50%) rotate(0deg)} to{transform:translateX(278px) translateY(-50%) rotate(-360deg)} }

  .orbit-wrapper {
    position:absolute; top:50%; left:50%; width:0; height:0; transform-origin:0 0;
  }
  .orbit-node {
    position:absolute;
    display:flex; align-items:center; gap:5px;
    padding:6px 13px; border-radius:20px;
    font-size:12px; font-weight:700; letter-spacing:0.6px;
    border:1.5px solid; cursor:pointer; white-space:nowrap;
    transition: box-shadow 0.2s ease;
    user-select:none;
  }
  .orbit-node:hover { z-index:50; }

  ${MODULES.map(m => {
    const cfg = RINGS[m.ring];
    const delay = -(m.startAngle / 360) * cfg.period;
    return `
      .wrapper-${m.id} { animation: orbit${m.ring} ${cfg.period}s linear infinite; animation-delay: ${delay}s; }
      .node-${m.id} { animation: counter${m.ring} ${cfg.period}s linear infinite; animation-delay: ${delay}s; color:${m.color}; background:${m.bg}; border-color:${m.color}40; box-shadow: 0 0 8px ${m.color}30; }
      .node-${m.id}:hover { box-shadow: 0 0 22px ${m.color}70, 0 4px 20px rgba(0,0,0,0.6); transform: translateX(${cfg.radius}px) translateY(-50%) rotate(var(--cr)) scale(1.18) !important; }
    `;
  }).join('')}
`;

export default function OrbitViz() {
  const [hovered, setHovered] = useState(null);
  const [tipPos, setTipPos] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);

  const handleEnter = (m, e) => {
    const cr = containerRef.current?.getBoundingClientRect();
    const nr = e.currentTarget.getBoundingClientRect();
    const x = nr.left - cr.left + nr.width / 2;
    const y = nr.top - cr.top + nr.height / 2;
    setHovered(m);
    setTipPos({ x, y });
  };

  return (
    <div style={{ background: "radial-gradient(ellipse at 30% 20%, #0d0d2b 0%, #050510 60%, #080820 100%)", minHeight: "100vh", display: "flex", flexDirection:"column", alignItems: "center", justifyContent: "center", fontFamily: "'Courier New', monospace" }}>
      <style>{css}</style>

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 11, letterSpacing: 6, color: "rgba(255,255,255,0.3)", marginBottom: 6 }}>WELCOME TO</div>
        <div style={{ fontSize: 36, fontWeight: 900, letterSpacing: 10, color: "white", textShadow: "0 0 30px rgba(120,100,255,0.7), 0 0 60px rgba(120,100,255,0.3)" }}>ORBIT</div>
        <div style={{ fontSize: 10, letterSpacing: 4, color: "rgba(255,255,255,0.25)", marginTop: 4 }}>YOUR PERSONAL TRADING SYSTEM</div>
      </div>

      {/* Main Viz */}
      <div ref={containerRef} style={{ position: "relative", width: W, height: H }}>

        {/* SVG layer — stars + rings */}
        <svg style={{ position: "absolute", inset: 0, overflow: "visible" }} width={W} height={H}>
          <defs>
            <radialGradient id="coreAura" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#7c6bea" stopOpacity="0.5" />
              <stop offset="60%" stopColor="#7c6bea" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#7c6bea" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="centerCore" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
            </radialGradient>
            {MODULES.map(m => (
              <radialGradient key={m.id} id={`g-${m.id}`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={m.color} stopOpacity="0.15" />
                <stop offset="100%" stopColor={m.color} stopOpacity="0" />
              </radialGradient>
            ))}
          </defs>

          {/* Stars */}
          {STARS.map(s => (
            <circle key={s.id} cx={s.cx} cy={s.cy} r={s.r} fill="white"
              style={{ animation: `twinkle ${s.dur}s ${s.delay}s ease-in-out infinite` }} />
          ))}

          {/* Orbital rings */}
          {Object.entries(RINGS).map(([ring, cfg], i) => (
            <circle key={ring} cx={W/2} cy={H/2} r={cfg.radius}
              fill="none" stroke="white" strokeWidth={0.5}
              strokeDasharray="3 10"
              style={{ animation: `ring-glow 3s ${i * 0.8}s ease-in-out infinite` }} />
          ))}

          {/* Soft aura behind center */}
          <circle cx={W/2} cy={H/2} r={80} fill="url(#coreAura)" />
          <circle cx={W/2} cy={H/2} r={40} fill="url(#centerCore)" />

          {/* Line to hovered node */}
          {hovered && (
            <line
              x1={W/2} y1={H/2}
              x2={tipPos.x} y2={tipPos.y}
              stroke={hovered.color} strokeWidth={1}
              strokeOpacity={0.25} strokeDasharray="4 5"
            />
          )}
        </svg>

        {/* Center ORBIT badge */}
        <div style={{
          position: "absolute", left: "50%", top: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center", zIndex: 20,
          animation: "center-breathe 4s ease-in-out infinite",
        }}>
          <div style={{ fontSize: 10, letterSpacing: 4, color: "rgba(255,255,255,0.35)", marginBottom: 3 }}>◈</div>
          <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: 6, color: "white",
            textShadow: "0 0 15px rgba(167,139,250,0.9), 0 0 30px rgba(167,139,250,0.5)" }}>ORBIT</div>
          <div style={{ fontSize: 7.5, letterSpacing: 3, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>CORE</div>
        </div>

        {/* Orbiting nodes */}
        {MODULES.map(m => (
          <div key={m.id} className={`orbit-wrapper wrapper-${m.id}`}>
            <div
              className={`orbit-node node-${m.id}`}
              onMouseEnter={(e) => handleEnter(m, e)}
              onMouseLeave={() => setHovered(null)}
            >
              <span style={{ fontSize: 13 }}>{m.emoji}</span>
              <span>{m.name}</span>
            </div>
          </div>
        ))}

        {/* Tooltip */}
        {hovered && (
          <div style={{
            position: "absolute",
            left: tipPos.x > W * 0.6 ? tipPos.x - 230 : tipPos.x + 20,
            top: Math.min(Math.max(tipPos.y - 55, 10), H - 130),
            width: 210,
            background: "rgba(8,8,24,0.96)",
            border: `1px solid ${hovered.color}35`,
            borderRadius: 12,
            padding: "14px 16px",
            boxShadow: `0 0 30px ${hovered.color}20, 0 8px 32px rgba(0,0,0,0.7)`,
            backdropFilter: "blur(12px)",
            zIndex: 200,
            animation: "tip-in 0.15s ease forwards",
            pointerEvents: "none",
          }}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>{hovered.emoji}</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: hovered.color, marginBottom: 5, letterSpacing: 0.3 }}>
              {hovered.tagline}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.6 }}>
              {hovered.detail}
            </div>
          </div>
        )}

        {/* Ring labels */}
        {[
          { ring: 1, label: "INNER", angle: -30 },
          { ring: 2, label: "MIDDLE", angle: -30 },
          { ring: 3, label: "OUTER", angle: -30 },
        ].map(({ ring, label, angle }) => {
          const r = RINGS[ring].radius;
          const rad = (angle * Math.PI) / 180;
          return (
            <div key={ring} style={{
              position: "absolute",
              left: W/2 + r * Math.cos(rad),
              top: H/2 + r * Math.sin(rad),
              transform: "translate(-50%, -50%)",
              fontSize: 7.5, letterSpacing: 2.5,
              color: "rgba(255,255,255,0.15)",
              pointerEvents: "none",
            }}>{label}</div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 20, display: "flex", gap: 18, flexWrap: "wrap", justifyContent: "center" }}>
        {MODULES.map(m => (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: 1 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.color, display: "inline-block" }} />
            {m.name.toUpperCase()}
          </div>
        ))}
      </div>
    </div>
  );
}
