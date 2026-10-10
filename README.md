# dsh-plugin-compat-guard

### 最大的兼容性保护 · The Biggest Compatibility Protection

> **English** | [中文文档](README.zh.md)

**⚠️ DO NOT INSTALL THIS ON A MACHINE YOU ARE WORKING ON. ⚠️**
It is a joke plugin. Its only feature is killing DeepSeek Harness on purpose.
See [LICENSE](LICENSE) — production use is prohibited by Section 1 of the Joke
Addendum, and broken hearts are explicitly not our problem.

---

Every Terraria player knows the feeling: install Calamity, lose the game.

This is that feeling, for DeepSeek Harness. A profile that mounts this plugin
stops being a profile that runs third-party plugins. Official plugins only. No
exceptions, no negotiation, no compatibility layer — the compatibility layer *is*
the verdict.

## What it does

1. It mounts, then waits for the Loader to finish mounting this boot's plugins
   (at most 90 s, usually a second or two).
2. It classifies every Loader row as official or third-party.
3. On the first third-party hit it writes the verdict to stderr, drops two
   forensics files, and calls `process.exit(1)`.
4. The process dies, the Electron shell sees the host disconnect, and the window
   goes with it.

That is the whole plugin. There is no second feature.

## Show me

```
================================================================
  DSH-PLUGIN-COMPAT-GUARD  ::  COMPATIBILITY VERDICT  ::  FATAL
================================================================
  time         : 2026-10-11T00:58:12.401Z
  profile      : C:\Users\<you>\.dsh\profiles\desktop
  installation : ...\app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json
  boot         : idle
  pid          : 24680
  exit code    : 1

  官方插件   : 96
  第三方插件 : 1

  -- 判决名单 ----------------------------------------------------
  [x] dsh-plugin-memory
      entry id  : dsh-memory
      specifier : dsh-plugin-memory
      resolved  : C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-plugin-memory
      fiber     : active   enabled: true
      reason    : resolved from the profile directory

  -- 遗言 --------------------------------------------------------
  「我把所有的依赖都读了一遍，只有它们是我没写过的。」
  「兼容性不是谈判，是判决。」
  ...
================================================================
```

## How "third-party" is decided

Two pieces of positive evidence, both mirroring the Plugin Manager's own view:

1. the package **resolves inside the profile directory** (resolution order is
   the installation anchor first, the profile second — exactly what
   `@deepseek-ai/dsh-app-boot` does), or
2. the package **name is declared in the profile's `package.json`
   `dependencies`**.

No evidence → official. If the profile directory cannot even be located, it
**withholds judgment and stays alive**. It would rather miss than misfire, which
is the one place where this plugin is more careful than you were.

It also never indicts itself — the guard is exempt from its own guard.

## Install

Through the Harness UI: **Settings → Plugins → Add plugin**, and give it this
package directory. From a shell, in a profile the CLI is allowed to manage:

```bash
dsh plugin --profile <name> add dsh-plugin-compat-guard
```

A local checkout works too — the Add-plugin dialog accepts an absolute path to a
package directory that declares `dsh.bundle`.

Then restart. **That restart is the demonstration.**

## Uninstall (how to rescue a profile that no longer boots)

Once installed, the GUI is unreachable — it dies mid-boot. Recovery is file- or
CLI-level, and the forensics file the plugin wrote tells you the same thing:

```bash
# 1) CLI, if this profile is CLI-managed
dsh plugin --profile <name> remove dsh-plugin-compat-guard
```

```bash
# 2) Hand-edit the profile manifest: drop the dependency and the same name from
#    dsh.profile.bundles   -> profiles/<name>/package.json
```

```bash
# 3) The blunt option: move the package away; the bundle is then skipped
mv ~/.dsh/profiles/<name>/node_modules/dsh-plugin-compat-guard /tmp/
```

The forensics files it leaves behind:

| Path | Content |
|---|---|
| `<profile>/.plugin-manager/logs/compat-guard-<timestamp>.log` | the full verdict |
| `<profile>/DONT_LOOK_HERE.txt` | the same report plus ten last words |

## Configuration

Override the row id `dsh-compat-guard` in the profile's `cordis.patch.yml`
(an override replaces the whole `config`, so restate the fields you keep):

```yaml
- id: dsh-compat-guard
  name: dsh-plugin-compat-guard
  config:
    enabled: false       # true = armed (default)
    dryRun: true         # true = print the verdict, kill nothing
    exitCode: 1          # be creative
    ignore: []           # spared package names / entry ids, e.g. ['dshmarket']
    writeForensics: true
    lastWordsPath: null  # profile-relative or absolute
    trace: false         # resolve traces on stderr
```

`dryRun: true` is the safe way to see the machinery without losing your session.
`enabled: false` makes it completely silent.

## Self-test (nothing dies)

```bash
node test/harness.mjs            # 12 scenarios, 41 assertions; real exits, in child processes
node test/probe-real-profile.mjs # read-only classification against this machine's profile
```

`harness.mjs` runs the plugin for real in child processes, so the "should die"
scenarios really do exit — the parent only collects exit codes and output.
`probe-real-profile.mjs` only recomputes the classification and prints it.

## Why not just a normal plugin?

| | Normal plugin | This plugin |
|---|---|---|
| Installed plugins | as many as you like | official only |
| On conflict | logs a warning | ends the process |
| Compatibility layer | negotiates | is the verdict |
| User experience | fine | gone |

## Compatibility

- **Official means "came from the installation", not "the name starts with
  `@deepseek-ai/`".** A scoped package placed in the profile is still indicted.
- It depends on Loader internals (`ctx.loader.entries()`, `getTasks()`,
  `Fiber.state === 2`, `entry.options.name/id/group/disabled`), verified against
  `@deepseek-ai/cordis-plugin-loader` in DSH 11.7.0. A future Loader could make
  it fail silently — at which point it simply stops killing things.
- It imports nothing at all and validates its own config (it implements
  `~standard.validate`), so there is no failure mode where the guard itself fails
  to load. A guard that cannot fail to load is a guard you cannot escape.
- It only judges the profile-level Loader tree. Rows composed by an agent preset
  live in a different tree and are out of scope.

## License

[MIT](LICENSE), plus a Joke Addendum that prohibits production use and accepts no
responsibility for anyone who ignores the first line of this README. You have
been warned twice now.
