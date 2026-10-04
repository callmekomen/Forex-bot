import { useCallback, useState } from "react";
import { Background } from "./components/Background";
import { TopBar, Ticker } from "./components/Chrome";
import { Hero } from "./components/Hero";
import { TradingDesk } from "./components/TradingDesk";
import { TelegramRemote } from "./components/TelegramRemote";
import { Architecture } from "./components/Architecture";
import { StrategyLab } from "./components/StrategyLab";
import { RiskLab } from "./components/RiskLab";
import { BacktestLab } from "./components/BacktestLab";
import { FileBrowser } from "./components/FileBrowser";
import { Footer, SetupSection } from "./components/SetupSection";
import { DeployGuide } from "./components/DeployGuide";
import { PhoneOps } from "./components/PhoneOps";

const Divider = () => (
  <div className="mx-auto h-px max-w-[1400px] bg-gradient-to-r from-transparent via-line to-transparent" />
);

export default function App() {
  // The source browser is the spine of the page: every other section deep-links into it.
  const [file, setFile] = useState("config.py");

  const openFile = useCallback((name: string) => {
    setFile(name);
    const target = document.getElementById("source");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="relative min-h-screen">
      <Background />
      <TopBar />
      <Ticker />
      <main className="relative">
        <Hero />
        <Divider />
        <TradingDesk />
        <Divider />
        <TelegramRemote />
        <Divider />
        <Architecture onOpenFile={openFile} />
        <Divider />
        <StrategyLab />
        <Divider />
        <RiskLab />
        <Divider />
        <BacktestLab />
        <Divider />
        <FileBrowser selected={file} onSelect={setFile} />
        <Divider />
        <SetupSection />
        <Divider />
        <DeployGuide onOpenFile={openFile} />
        <Divider />
        <PhoneOps />
      </main>
      <Footer onOpenFile={openFile} />
    </div>
  );
}
