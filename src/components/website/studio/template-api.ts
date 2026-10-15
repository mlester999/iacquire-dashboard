import {
  getTemplateDraftAction, getTemplateVersionAction, listTemplateVersionsAction, restoreTemplateVersionAction, saveTemplateDraftAction, setTemplateStatusAction, templatePreflightAction,
} from "@/app/actions/website-admin";
import type { StudioApi } from "./studio-api";
import type { VersionView } from "@/server/websites/service";

/**
 * The editor's server calls when it is editing one of the agency's templates instead of a client's website. A template's "versions" are its
 * published versions; "publish" makes the working copy the one clients are offered; "send for approval" asks a super admin to publish it.
 * Templates use generated starter images and built-in artwork. Client websites can replace them in their own editor.
 */
export function createTemplateStudioApi(id: string, key: string): StudioApi {
  return {
    async saveDraft(content, revision) {
      const res = await saveTemplateDraftAction(id, content, revision);
      return res.ok ? { ok: true, revision: res.data.revision } : { ok: false, error: res.error, conflict: res.code === "conflict" };
    },
    async getDraft() {
      const res = await getTemplateDraftAction(id);
      return res.ok ? { ok: true, data: { content: res.data.content, revision: res.data.revision, templateKey: res.data.key } } : res;
    },
    async saveVersion() {
      return { ok: false, error: "Templates keep a version each time they are published." };
    },
    async listVersions() {
      const res = await listTemplateVersionsAction(id);
      if (!res.ok) return res;
      const versions: VersionView[] = res.data.map((v) => ({ id: String(v.version), version: v.version, templateKey: key, source: "publish", note: v.note, createdAt: v.createdAt, createdByName: v.createdByName, isLive: false }));
      return { ok: true, data: versions };
    },
    async previewVersion(versionId) {
      const res = await getTemplateVersionAction(id, Number(versionId));
      return res.ok ? { ok: true, data: { content: res.data.content, templateKey: key, version: Number(versionId) } } : res;
    },
    async restoreVersion(versionId) {
      const res = await restoreTemplateVersionAction(id, Number(versionId));
      if (!res.ok) return res;
      const d = await getTemplateDraftAction(id);
      return d.ok ? { ok: true, data: { revision: d.data.revision } } : d;
    },
    async regenerate() {
      return { ok: false, error: "Not available for templates." };
    },
    async preflight() {
      const res = await templatePreflightAction(id);
      if (!res.ok) return res;
      return { ok: true, data: { blockers: res.data.blockers, warnings: res.data.warnings, needsAcknowledgement: [], canPublishNow: res.data.blockers.length === 0 } };
    },
    async publish(_ack, note) {
      const res = await setTemplateStatusAction(key, "published", note);
      return res.ok
        ? { ok: true, data: { publicationId: `${id}:${res.data.version}`, number: res.data.version, host: "the template library", health: "healthy", healthDetail: "Offered to clients from now on. Websites already created from it keep their own copy.", restoredPrevious: false } }
        : { ok: false, error: res.error, code: res.code };
    },
    async submitForApproval() {
      const res = await setTemplateStatusAction(key, "in_review");
      return res.ok ? { ok: true, data: { versionId: id } } : { ok: false, error: res.error, code: res.code };
    },
    async listAssets() {
      return { ok: true, data: [] };
    },
    async uploadAsset() {
      return { ok: false, error: "Template images are shared starter assets. Replace images on the client's website instead." };
    },
    async setAssetAlt() {
      return { ok: true, data: {} };
    },
    async deleteAsset() {
      return { ok: true, data: {} };
    },
    assetUrl: () => "",
  };
}
