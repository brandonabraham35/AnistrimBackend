import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Sharingan } from "@/components/sharingan";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { currentAdmin, signOut } from "@/lib/admin-session";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Mission Control — Uchiha Console" },
      {
        name: "description",
        content:
          "Itachi-themed admin dashboard tracking active missions, clan members and chakra network status.",
      },
      { property: "og:title", content: "Mission Control — Uchiha Console" },
      {
        property: "og:description",
        content: "Track missions, clan members and network status in the Uchiha admin console.",
      },
    ],
  }),
  component: DashboardPage,
});

const stats = [
  { label: "Active Missions", value: "18", delta: "+3 this week" },
  { label: "Clan Members", value: "247", delta: "+12 recruits" },
  { label: "Chakra Load", value: "72%", delta: "stable" },
  { label: "Threat Level", value: "S", delta: "Akatsuki activity" },
];

const missions = [
  { id: "MSN-001", name: "Escort the Daimyō", rank: "A", lead: "Itachi U.", status: "In Progress", progress: 68 },
  { id: "MSN-014", name: "Recover the Scroll of Seals", rank: "S", lead: "Shisui U.", status: "Critical", progress: 34 },
  { id: "MSN-027", name: "Border Patrol — North Gate", rank: "C", lead: "Izumi U.", status: "Complete", progress: 100 },
  { id: "MSN-033", name: "Track the Red Cloud", rank: "S", lead: "Sasuke U.", status: "In Progress", progress: 51 },
  { id: "MSN-041", name: "Genin Trial Oversight", rank: "D", lead: "Yashiro U.", status: "Queued", progress: 8 },
];

const feed = [
  { time: "02:14", text: "Crow summon dispatched to the eastern outpost." },
  { time: "01:47", text: "Sharingan clearance granted to Shisui U." },
  { time: "23:09", text: "Anomalous chakra spike detected near the Nakano Shrine." },
  { time: "21:32", text: "Mission MSN-027 marked complete. No casualties." },
];

function statusTone(status: string) {
  if (status === "Critical") return "bg-primary text-primary-foreground";
  if (status === "Complete") return "bg-secondary text-secondary-foreground";
  return "bg-accent text-accent-foreground";
}

function DashboardPage() {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<string | null>(null);

  useEffect(() => {
    setAdmin(currentAdmin() ?? "itachi");
  }, []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
          <Sharingan className="h-9 w-9" spinning />
          <div className="mr-auto">
            <h1 className="text-lg leading-tight">Uchiha Console</h1>
            <p className="text-[0.65rem] uppercase tracking-[0.35em] text-muted-foreground">
              Mission Control
            </p>
          </div>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            Signed in as <span className="text-foreground">{admin ?? "…"}</span>
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              signOut();
              navigate({ to: "/" });
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-border bg-card p-5 shadow-ink"
            >
              <p className="text-[0.65rem] uppercase tracking-[0.3em] text-muted-foreground">
                {stat.label}
              </p>
              <p className="mt-3 font-display text-3xl text-glow">{stat.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{stat.delta}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
          <div className="rounded-lg border border-border bg-card shadow-ink">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <h2 className="text-base">Mission Roster</h2>
              <Badge className="bg-primary text-primary-foreground">Live</Badge>
            </div>
            <div className="divide-y divide-border">
              {missions.map((mission) => (
                <article key={mission.id} className="px-6 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-xs text-muted-foreground">{mission.id}</span>
                    <span className="mr-auto text-sm text-foreground">{mission.name}</span>
                    <span className="text-xs text-muted-foreground">Rank {mission.rank}</span>
                    <span
                      className={`rounded-sm px-2 py-0.5 text-[0.65rem] uppercase tracking-[0.2em] ${statusTone(mission.status)}`}
                    >
                      {mission.status}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <Progress value={mission.progress} className="h-1.5" />
                    <span className="w-20 text-right text-xs text-muted-foreground">
                      {mission.lead}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-6 shadow-ink">
              <h2 className="text-base">Crow Network</h2>
              <ul className="mt-4 space-y-4">
                {feed.map((item) => (
                  <li key={item.time} className="flex gap-3">
                    <span className="font-mono text-xs text-primary">{item.time}</span>
                    <span className="text-sm text-muted-foreground">{item.text}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative overflow-hidden rounded-lg border border-border bg-card p-6 shadow-ink">
              <div className="pointer-events-none absolute inset-0 bg-sharingan" />
              <div className="relative">
                <h2 className="text-base">Tsukuyomi Protocol</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Lock the console and place all active agents under genjutsu silence.
                </p>
                <Button className="mt-5 w-full uppercase tracking-[0.3em] shadow-crimson">
                  Engage
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}