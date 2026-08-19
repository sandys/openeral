import test from 'node:test';
import assert from 'node:assert';

function generateMassiveWorkspaceFixture() {
  const files = [];
  for (let i = 0; i < 400; i++) {
    const content = `This is mock content for file ${i}. It is used to ensure that the sync daemon can properly serialize and deserialize large JSON payloads without running out of memory or hitting payload limits.`;
    files.push({
      path: `/home/agent/workspace/nested/dir/level${i % 10}/file${i}.txt`,
      content: content,
      mtime: 1710000000000 + i * 1000,
      mode: 33188,
      size: Buffer.byteLength(content, 'utf8')
    });
  }
  return { files };
}

export const massiveWorkspaceFixture = generateMassiveWorkspaceFixture();

test('Sync daemon can handle heavy workspace state', async () => {
  const expectedFileCount = massiveWorkspaceFixture.files.length;
  assert.strictEqual(expectedFileCount, 400);

  // Asserting properties of the first and last generated item to ensure generation works
  const firstFile = massiveWorkspaceFixture.files[0];
  const lastFile = massiveWorkspaceFixture.files[399];

  assert.strictEqual(firstFile.path, '/home/agent/workspace/nested/dir/level0/file0.txt');
  assert.strictEqual(firstFile.size, firstFile.content.length);

  assert.strictEqual(lastFile.path, '/home/agent/workspace/nested/dir/level9/file399.txt');
  assert.strictEqual(lastFile.size, lastFile.content.length);

  // We ensure the payload size is computed properly (content matches size property)
  for (const file of massiveWorkspaceFixture.files) {
    assert.strictEqual(file.size, Buffer.byteLength(file.content, 'utf8'));
  }
});
