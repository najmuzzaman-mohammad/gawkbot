/**
 * BoxAccountSection — Settings → Keys: the ascii.dev Box account. Sign in,
 * sign out and sign in again, paste a key, and the plan gate with a link
 * to start the trial or a plan. Replaces the bare key field.
 */

import { useQueryClient } from "@tanstack/react-query";

import { BoxCloudConnect } from "../../computer/BoxCloudConnect";
import { Field, SettingsGroup } from "./components";

export function BoxAccountSection() {
  const queryClient = useQueryClient();
  return (
    <SettingsGroup title="Cloud computers">
      <Field
        label="ascii.dev Box"
        hint="Cloud computers for your bots. Env: WUPHF_BOX_API_KEY. Signing out revokes the gawkbot key on your account and ends the CLI session."
        stacked={true}
      >
        <BoxCloudConnect
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ["config"] });
            void queryClient.invalidateQueries({
              queryKey: ["computer-runtime"],
            });
          }}
        />
      </Field>
    </SettingsGroup>
  );
}
