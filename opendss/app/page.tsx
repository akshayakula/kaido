const populatedLights = [
  [26, 34], [28, 37], [32, 42], [36, 36], [41, 31], [47, 28], [53, 31], [59, 36],
  [64, 42], [69, 49], [73, 57], [67, 64], [60, 70], [51, 73], [42, 70], [34, 63],
  [28, 55], [24, 48], [31, 47], [38, 51], [45, 54], [55, 52], [62, 48], [57, 61],
];

const gridDots = [
  { label: 'PJM', x: 36, y: 43 },
  { label: 'ERCOT', x: 31, y: 56 },
  { label: 'CAISO', x: 23, y: 50 },
  { label: 'WECC', x: 24, y: 39 },
  { label: 'MISO', x: 41, y: 39 },
  { label: 'SERC', x: 43, y: 55 },
  { label: 'NYISO', x: 48, y: 38 },
];

export default function Home() {
  return (
    <main className="franklin-home">
      <div className="home-globe-layer" aria-hidden="true">
        <div className="home-globe">
          <svg viewBox="0 0 100 100">
            <circle className="home-globe-disc" cx="50" cy="50" r="44" />
            <g className="home-globe-lines">
              {[20, 35, 50, 65, 80].map((x) => <path key={`lon-${x}`} d={`M${x} 7 C${50 + (x - 50) * 0.42} 25 ${50 + (x - 50) * 0.42} 75 ${x} 93`} />)}
              {[20, 35, 50, 65, 80].map((y) => <ellipse key={`lat-${y}`} cx="50" cy={y} rx={44 - Math.abs(y - 50) * 0.4} ry="5" />)}
            </g>
            {populatedLights.map(([x, y], index) => <circle className="home-light" key={index} cx={x} cy={y} r="0.65" />)}
          </svg>
          {gridDots.map((dot) => (
            <a
              className="home-grid-dot"
              href="/join"
              key={dot.label}
              style={{ left: `${dot.x}%`, top: `${dot.y}%` }}
              aria-label={`Join through ${dot.label}`}
            >
              <span>{dot.label}</span>
            </a>
          ))}
        </div>
      </div>

      <header className="home-header">
        <p>
          Franklin allows you to sonically understand the health of transformers and optimize the grid to the edge
          using cross data center agentic communication.
          <br />
          <br />
          Lighting does strike twice.
        </p>
        <nav>
          <a href="/join">Join as data center</a>
          <a href="/dashboard">Live grid</a>
        </nav>
        <p className="home-credits">
          <a href="https://www.linkedin.com/in/andrescz/" target="_blank" rel="noopener noreferrer">Andres Cruz</a>
          ,{' '}
          <a href="https://www.linkedin.com/in/akshayakula/" target="_blank" rel="noopener noreferrer">Akshay Akula</a>
          ,{' '}
          <a href="https://www.linkedin.com/in/puneet-velidi/" target="_blank" rel="noopener noreferrer">Puneet Velidi</a>
        </p>
      </header>

      <div className="home-spacer" />

      <footer className="home-footer">
        <h1 aria-label="Franklin">FRANKLIN</h1>
      </footer>
    </main>
  );
}
