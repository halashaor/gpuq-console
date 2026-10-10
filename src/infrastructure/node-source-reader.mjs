/** Explicit source selection: no managed source is inferred from a directory. */
export class NodeSourceReader {
  constructor({directories, managed}) {
    this.directories = directories;
    this.managed = managed;
  }
  async inspect(request, context) {
    const reader = request.source.kind === 'directory' ? this.directories : this.managed;
    return reader.inspect(request, context);
  }
}
