import { HomeMapboxGlobe } from '@/components/HomeMapboxGlobe';

export default function Home() {
  return (
    <main className="franklin-home">
      <div className="home-globe-layer" aria-hidden="true">
        <HomeMapboxGlobe />
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
          <a href="/grid-sensor">Franklin sensors</a>
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
