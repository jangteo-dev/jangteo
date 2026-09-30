import { Component, type ReactNode } from "react";
import { useLang } from "../i18n";

function Crashed() {
  const { t } = useLang();
  return (
    <main className="page crashed" role="alert">
      <h1>{t.crash.title}</h1>
      <p className="lede">{t.crash.body}</p>
      <p className="crashed__acts">
        <button className="btn btn--ink" onClick={() => location.reload()}>
          {t.crash.reload}
        </button>
        <a className="btn btn--line" href="#/" onClick={() => setTimeout(() => location.reload(), 50)}>
          {t.crash.home}
        </a>
      </p>
    </main>
  );
}

/** One page failing to draw shows a way back instead of a blank screen. Keyed by route, so moving on clears it. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error("page crashed", err);
  }
  render() {
    return this.state.failed ? <Crashed /> : this.props.children;
  }
}
