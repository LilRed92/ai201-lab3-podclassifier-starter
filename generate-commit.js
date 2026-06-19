require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');

const commitMsgFile = process.argv[2];
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
	console.error("❌ GEMINI_API_KEY environment variable is missing.");
	process.exit(1);
}

async function generateCommitMessage() {
	// 1. Get staged files to determine scope and for the fallback
	const stagedFiles = execSync('git diff --cached --name-only').toString().trim().split('\n');
	if (!stagedFiles.length || stagedFiles[0] === '') process.exit(0);

	// 2. Determine Agent Project Scope
	let scope = 'core';
	const touchesDocs = stagedFiles.some(f => f.endsWith('.md'));
	const touchesEnv = stagedFiles.some(f => f === 'requirements.txt' || f === 'package.json');
	const touchesTools = stagedFiles.some(f => f.includes('tool') || f.includes('search') || f.includes('outfit') || f.includes('card'));
	const touchesAgent = stagedFiles.some(f => f.includes('agent') || f.includes('loop') || f.includes('main'));

	if (touchesAgent && touchesTools) scope = 'agent-orchestration';
	else if (touchesAgent) scope = 'agent';
	else if (touchesTools) scope = 'tools';
	else if (touchesDocs) scope = 'docs';
	else if (touchesEnv) scope = 'env';

	// 3. Get the actual code changes (Filtered for Python virtual environments and caches)
	let diff = '';
	try {
		diff = execSync('git diff --cached -- . ":(exclude).venv/*" ":(exclude)__pycache__/*" ":(exclude).husky/*"').toString().trim();
	} catch (err) {
		diff = execSync('git diff --cached').toString().trim();
	}

	if (!diff) {
		diff = execSync('git diff --cached').toString().trim();
	}
	if (diff.length > 8000) diff = diff.substring(0, 8000) + "\n...[diff truncated]";

	// 4. Dynamically read your custom rules
	let customRules = '';
	try {
		customRules = fs.readFileSync('.ai-commit-rules.txt', 'utf8');
	} catch (err) {
		customRules = 'No additional custom rules provided.';
	}

	// 5. The strict instructions for Gemini
	const prompt = `
	You are an expert developer. Read the following git diff and write a Conventional Commit message.

	Core Rules:
	1. Start the subject line with exactly one relevant Gitmoji (e.g., ✨, 🐛, ♻️, 📝, 📦).
	2. Use a conventional type (feat, fix, chore, refactor, style, docs, test).
	3. You MUST use this exact scope: (${scope}).
	4. Format: Subject line, followed by a blank line, followed by a bulleted body (if the diff warrants detailed explanation).

	Custom Project Rules (Follow these strictly):
	${customRules}

	Git Diff:
	${diff}
	`;

	console.log(`🤖 Asking Gemini to analyze your changes...`);

	// 6. Call the Gemini API
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30000);

		const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
			signal: controller.signal
		});

		clearTimeout(timeoutId);
		const data = await response.json();

		if (data.error) throw new Error(data.error.message);

		let aiMessage = data.candidates[0].content.parts[0].text.trim();
		aiMessage = aiMessage.replace(/^```\w*\n|\n```$/g, '');

		if (commitMsgFile) {
			const currentMsg = fs.readFileSync(commitMsgFile, 'utf8');
			fs.writeFileSync(commitMsgFile, aiMessage + "\n\n" + currentMsg);
		}
		console.log(`✅ Success!`);

	} catch (err) {
		// 7. The Offline Fallback Logic
		console.error("\n⚠️ AI Generation failed. Using offline fallback.");
		console.error("🔍 Exact Error:", err.message);

		let type = 'chore';
		if (stagedFiles.some(f => f.includes('test') || f.includes('pytest'))) type = 'test';
		else if (stagedFiles.some(f => f.endsWith('.py'))) type = 'feat';
		else if (stagedFiles.some(f => f.endsWith('.md'))) type = 'docs';

		const fileSummary = stagedFiles.length > 2
			? `${stagedFiles.slice(0, 2).map(f => f.split('/').pop()).join(', ')}...`
			: stagedFiles.map(f => f.split('/').pop()).join(', ');

		const fallbackMsg = `🤖 ${type}(${scope}): update ${fileSummary}\n\n[Auto-generated offline fallback]`;

		if (commitMsgFile) {
			const currentMsg = fs.readFileSync(commitMsgFile, 'utf8');
			fs.writeFileSync(commitMsgFile, fallbackMsg + "\n\n" + currentMsg);
		}
	}
}

generateCommitMessage();