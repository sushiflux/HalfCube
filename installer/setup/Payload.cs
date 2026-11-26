using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HalfCube.Setup;

/// <summary>What the build script says about the package inside the setup (the ZIP entry <c>payload.json</c>).</summary>
internal sealed record PayloadInfo(
    int FormatVersion,
    string PackId,
    string Title,
    string Version,
    string DisplayVersion,
    string Channel,
    string MainExe,
    long InstalledBytes,
    long SetupBytes)
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
}

/// <summary>
/// What the setup carries: a ZIP appended to the end of the setup exe (scripts/build-installer.ps1), found through a trailer -
/// "HCUBEP01", offset and length of the ZIP (little-endian Int64) and its SHA-256. The ZIP holds Velopack's own <c>Setup.exe</c>
/// (stored, not compressed again: it is already compressed), <c>payload.json</c>, the licence text and the NOTICE file (LGPL-2.1 section 6 wants both with every copy). The trailer is searched in the
/// last 64 KiB, so a later Authenticode signature (which appends its certificate table) does not break it. The checksum is verified
/// before anything is run: a damaged download never starts a half installation. For tests the ZIP can come from a file
/// (<c>--payload</c>).
/// </summary>
internal sealed class Payload : IDisposable
{
    public static readonly byte[] Magic = "HCUBEP01"u8.ToArray();
    public const int TrailerSize = 8 + 8 + 8 + 32;
    public const string VelopackEntry = "Setup.exe";
    public const string InfoEntry = "payload.json";
    public const string LicenceEntry = "LICENSE";
    public const string NoticeEntry = "NOTICE";

    private readonly string _file;
    private readonly long _offset;
    private readonly long _length;
    private readonly byte[] _sha256;
    private ZipArchive? _zip;

    private Payload(string file, long offset, long length, byte[] sha256)
    {
        _file = file;
        _offset = offset;
        _length = length;
        _sha256 = sha256;
    }

    /// <summary>The payload appended to <paramref name="exe"/>, or null when there is none (a plain build of the setup).</summary>
    public static Payload? FromExe(string exe)
    {
        using var stream = File.OpenRead(exe);
        var window = (int)Math.Min(stream.Length, 64 * 1024);
        var tail = new byte[window];
        stream.Seek(-window, SeekOrigin.End);
        stream.ReadExactly(tail);
        var at = tail.AsSpan().LastIndexOf(Magic);
        if (at < 0 || at + TrailerSize > tail.Length) return null;
        var offset = BitConverter.ToInt64(tail, at + 8);
        var length = BitConverter.ToInt64(tail, at + 16);
        var hash = tail.AsSpan(at + 24, 32).ToArray();
        var trailerPosition = stream.Length - window + at;
        if (offset <= 0 || length <= 0 || offset + length > trailerPosition) return null;
        return new Payload(exe, offset, length, hash);
    }

    /// <summary>A plain ZIP file as payload (tests); its checksum is computed, not checked.</summary>
    public static Payload FromZip(string zip)
    {
        using var stream = File.OpenRead(zip);
        return new Payload(zip, 0, stream.Length, SHA256.HashData(stream));
    }

    /// <summary>Appends <paramref name="zip"/> plus trailer to <paramref name="exe"/> (used by the build script through "--append-payload").</summary>
    public static void Append(string exe, string zip)
    {
        using var output = new FileStream(exe, FileMode.Append, FileAccess.Write);
        var offset = output.Position;
        byte[] hash;
        using (var input = File.OpenRead(zip))
        {
            hash = SHA256.HashData(input);
            input.Position = 0;
            input.CopyTo(output);
        }
        var length = output.Position - offset;
        output.Write(Magic);
        output.Write(BitConverter.GetBytes(offset));
        output.Write(BitConverter.GetBytes(length));
        output.Write(hash);
    }

    /// <summary>True when the bytes match the checksum from the trailer.</summary>
    public bool Verify()
    {
        using var stream = Open();
        return SHA256.HashData(stream).AsSpan().SequenceEqual(_sha256);
    }

    private Stream Open()
    {
        var file = new FileStream(_file, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
        return new SubStream(file, _offset, _length);
    }

    private ZipArchive Zip => _zip ??= new ZipArchive(Open(), ZipArchiveMode.Read, leaveOpen: false);

    private ZipArchiveEntry? Find(string entry)
    {
        // Some ZIP tools write backslashes into entry names (Windows PowerShell 5.1 Compress-Archive): compare normalised
        var wanted = entry.Replace('\\', '/');
        return Zip.Entries.FirstOrDefault(x => string.Equals(x.FullName.Replace('\\', '/'), wanted, StringComparison.OrdinalIgnoreCase));
    }

    public string? ReadText(string entry)
    {
        if (Find(entry) is not { } e) return null;
        using var reader = new StreamReader(e.Open(), Encoding.UTF8);
        return reader.ReadToEnd();
    }

    public PayloadInfo? ReadInfo()
    {
        var text = ReadText(InfoEntry);
        return text is null ? null : JsonSerializer.Deserialize<PayloadInfo>(text, PayloadInfo.Json);
    }

    public long EntrySize(string entry) => Find(entry)?.Length ?? 0;

    /// <summary>Extracts one entry to <paramref name="target"/> (a file path), reporting the share written (0..1).</summary>
    public void ExtractEntry(string entry, string target, IProgress<float>? progress, CancellationToken ct)
    {
        var e = Find(entry) ?? throw new InvalidDataException($"The setup file has no entry {entry}.");
        var total = Math.Max(1, e.Length);
        using var input = e.Open();
        using var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);
        var buffer = new byte[1 << 20];
        long done = 0;
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            ct.ThrowIfCancellationRequested();
            output.Write(buffer, 0, read);
            done += read;
            progress?.Report(done / (float)total);
        }
    }

    public void Dispose() => _zip?.Dispose();

    /// <summary>A read-only window into another stream.</summary>
    private sealed class SubStream(Stream inner, long offset, long length) : Stream
    {
        private long _position;

        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => length;

        public override long Position
        {
            get => _position;
            set => _position = Math.Clamp(value, 0, length);
        }

        public override int Read(byte[] buffer, int start, int count) => Read(buffer.AsSpan(start, count));

        public override int Read(Span<byte> buffer)
        {
            var remaining = length - _position;
            if (remaining <= 0) return 0;
            if (buffer.Length > remaining) buffer = buffer[..(int)remaining];
            inner.Position = offset + _position;
            var read = inner.Read(buffer);
            _position += read;
            return read;
        }

        public override long Seek(long position, SeekOrigin origin) => Position = origin switch
        {
            SeekOrigin.Begin => position,
            SeekOrigin.Current => _position + position,
            _ => length + position,
        };

        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int start, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
