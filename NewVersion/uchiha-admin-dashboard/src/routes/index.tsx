import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import heroImage from "@/assets/itachi-hero.jpg";
import { Sharingan } from "@/components/sharingan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/lib/admin-session";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Uchiha Console — Admin Sign In" },
      {
        name: "description",
        content:
          "Sign in to the Uchiha Console, an Itachi-inspired admin panel for clan operations and mission oversight.",
      },
      { property: "og:title", content: "Uchiha Console — Admin Sign In" },
      {
        property: "og:description",
        content: "Itachi-inspired admin sign in for clan operations and mission oversight.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("itachi");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || code.trim().length < 4) {
      setError("The eyes cannot lie. Enter a name and a code of at least 4 characters.");
      return;
    }
    signIn(name.trim());
    navigate({ to: "/dashboard" });
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden lg:block">
        <img
          src={heroImage}
          alt="Cloaked shinobi standing beneath a crimson moon"
          width={1024}
          height={1536}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-ink-fade" />
        <blockquote className="absolute bottom-14 left-14 right-14 border-l-2 border-primary pl-6">
          <p className="font-display text-2xl leading-snug text-foreground">
            “People live their lives bound by what they accept as correct and true.”
          </p>
          <footer className="mt-3 text-xs uppercase tracking-[0.4em] text-muted-foreground">
            Itachi Uchiha
          </footer>
        </blockquote>
      </section>

      <section className="relative flex items-center justify-center px-6 py-16">
        <div className="pointer-events-none absolute inset-0 bg-sharingan opacity-70" />
        <div className="relative w-full max-w-sm">
          <div className="flex items-center gap-4">
            <Sharingan className="h-12 w-12" spinning />
            <div>
              <p className="text-[0.65rem] uppercase tracking-[0.45em] text-muted-foreground">
                Konoha · Restricted
              </p>
              <h1 className="text-2xl text-glow">Uchiha Console</h1>
            </div>
          </div>

          <p className="mt-8 text-sm text-muted-foreground">
            Only those who awaken the eye may pass. Present your credentials.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-xs uppercase tracking-[0.3em]">
                Shinobi ID
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="username"
                className="h-11 bg-card"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="code" className="text-xs uppercase tracking-[0.3em]">
                Kekkei Code
              </Label>
              <Input
                id="code"
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
                className="h-11 bg-card"
              />
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button
              type="submit"
              className="h-11 w-full uppercase tracking-[0.3em] shadow-crimson"
            >
              Awaken
            </Button>
          </form>

          <p className="mt-8 text-center text-xs text-muted-foreground">
            Demo access — any ID with a 4+ character code opens the console.
          </p>
        </div>
      </section>
    </main>
  );
}
