import { join, resolve, sep } from "node:path";

/** List all skill names from provider/skills/ */
export async function readSkills(skillsDir: string): Promise<string[]> {
	const glob = new Bun.Glob("*/SKILL.md");
	const skills: string[] = [];
	try {
		for await (const path of glob.scan({ cwd: skillsDir })) {
			skills.push(path.split("/")[0]);
		}
	} catch {
		// skills dir may not exist
	}
	return skills;
}

/** Read a specific skill's SKILL.md content. */
export async function readSkillContent(
	skillsDir: string,
	name: string,
): Promise<string> {
	if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
		throw new Error(`Invalid skill name: ${name}`);
	}
	const root = resolve(skillsDir);
	const filePath = resolve(root, name, "SKILL.md");
	if (!filePath.startsWith(root + sep)) {
		throw new Error(`Invalid skill name: ${name}`);
	}
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		throw new Error(`Skill not found: ${name}`);
	}
	return file.text();
}
