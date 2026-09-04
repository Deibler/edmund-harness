import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import {
  useApproveSkill,
  useSetSkillDisabled,
  useSkills,
  useUninstallSkill,
} from "@/features/skills/useSkills";
import { fmtTime, relativeTime } from "@/lib/time";

export function SkillsPage() {
  const { data, isLoading } = useSkills();
  const approve = useApproveSkill();
  const setDisabled = useSetSkillDisabled();
  const uninstall = useUninstallSkill();
  const skills = data?.skills ?? [];
  const cfg = data?.config;

  return (
    <div>
      <PageHeader
        title="Skills"
        description="Installed marketplace skills. Approve skills that ship scripts before the model can run them. Install is CLI-only."
      />
      {cfg ? (
        <Card className="mb-4">
          <CardHeader title="Marketplace config" />
          <CardBody className="text-sm space-y-1">
            <div>
              <span className="text-muted">Enabled: </span>
              {cfg.enabled ? <Badge tone="ok">on</Badge> : <Badge tone="neutral">off</Badge>}
            </div>
            <div>
              <span className="text-muted">Allowed sources: </span>
              <code className="text-xs">{cfg.allowedSources.join(", ")}</code>
            </div>
            <div>
              <span className="text-muted">Require approval for scripts: </span>
              {cfg.requireApprovalForScripts ? "yes" : "no"}
            </div>
            <div>
              <span className="text-muted">Installed DB: </span>
              <code className="text-xs">{cfg.installedDbPath}</code>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="text-sm text-muted">No skills installed.</p>
      ) : (
        <Card>
          <CardBody className="p-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Source</Th>
                  <Th>Version</Th>
                  <Th>Installed</Th>
                  <Th>State</Th>
                  <Th />
                </Tr>
              </Thead>
              <tbody>
                {skills.map((s) => (
                  <Tr key={s.name}>
                    <Td className="font-mono text-xs">{s.name}</Td>
                    <Td className="text-xs text-muted">{s.source}</Td>
                    <Td className="text-xs">{s.version ?? "—"}</Td>
                    <Td className="text-xs" title={fmtTime(s.installedAt)}>
                      {relativeTime(s.installedAt)}
                    </Td>
                    <Td className="text-xs space-x-1">
                      {s.disabled ? (
                        <Badge tone="warn">disabled</Badge>
                      ) : (
                        <Badge tone="ok">active</Badge>
                      )}
                      {s.hasScripts ? <Badge tone="accent">scripts</Badge> : null}
                      {s.needsApproval ? <Badge tone="danger">needs approval</Badge> : null}
                    </Td>
                    <Td className="space-x-1">
                      {s.needsApproval ? (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate(s.name)}
                        >
                          Approve
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={setDisabled.isPending}
                        onClick={() => setDisabled.mutate({ name: s.name, disabled: !s.disabled })}
                      >
                        {s.disabled ? "Enable" : "Disable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={uninstall.isPending}
                        onClick={() => {
                          if (confirm(`Uninstall ${s.name}?`)) uninstall.mutate(s.name);
                        }}
                      >
                        Uninstall
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
