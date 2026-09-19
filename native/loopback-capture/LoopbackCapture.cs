// Captures everything the PC is playing EXCEPT the audio of one process tree,
// using WASAPI process loopback (Windows 10 build 20348+ / Windows 11).
//
//   loopback-capture.exe --exclude-pid <pid>
//
// stdout: raw PCM, 48 kHz, 2 channels, signed 16-bit little endian
// stderr: "READY" once capturing, or "ERROR <message>" before exiting
//
// Written in C# 5 so it builds with the csc.exe that ships with Windows
// (.NET Framework 4.x) and runs on any Windows 10/11 without extra installs.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class Program
{
    const int SampleRate = 48000;
    const int Channels = 2;
    const int BitsPerSample = 16;
    const int BlockAlign = Channels * BitsPerSample / 8;

    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const long BufferDuration100ns = 200000; // 20 ms

    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    [MTAThread]
    static int Main(string[] args)
    {
        int excludePid = -1;
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--exclude-pid") int.TryParse(args[i + 1], out excludePid);
        }

        if (excludePid <= 0)
        {
            Console.Error.WriteLine("ERROR usage: loopback-capture.exe --exclude-pid <pid>");
            return 2;
        }

        try
        {
            Run(excludePid);
            return 0;
        }
        catch (IOException)
        {
            return 0; // stdout closed by the parent: normal shutdown
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("ERROR " + e.Message);
            return 1;
        }
    }

    static void Run(int excludePid)
    {
        IAudioClient client = ActivateProcessLoopback((uint)excludePid);

        IntPtr format = AllocWaveFormat();
        try
        {
            client.Initialize(0 /* shared */,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                BufferDuration100ns, 0, format, IntPtr.Zero);
        }
        finally
        {
            Marshal.FreeHGlobal(format);
        }

        AutoResetEvent packetReady = new AutoResetEvent(false);
        client.SetEventHandle(packetReady.SafeWaitHandle.DangerousGetHandle());

        object service;
        client.GetService(IID_IAudioCaptureClient, out service);
        IAudioCaptureClient capture = (IAudioCaptureClient)service;

        // The excluded process is our parent; stop when it goes away
        Process parent = null;
        try { parent = Process.GetProcessById(excludePid); } catch (ArgumentException) { }

        client.Start();
        Console.Error.WriteLine("READY");
        Console.Error.Flush();

        Stream stdout = Console.OpenStandardOutput();
        byte[] buffer = new byte[SampleRate / 10 * BlockAlign];

        try
        {
            while (true)
            {
                packetReady.WaitOne(200);
                if (parent != null && parent.HasExited) return;

                uint packetFrames;
                capture.GetNextPacketSize(out packetFrames);
                while (packetFrames > 0)
                {
                    IntPtr data;
                    uint frames, flags;
                    ulong devicePosition, qpcPosition;
                    capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);

                    int bytes = (int)frames * BlockAlign;
                    if (buffer.Length < bytes) buffer = new byte[bytes];
                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(buffer, 0, bytes);
                    else Marshal.Copy(data, buffer, 0, bytes);

                    capture.ReleaseBuffer(frames);
                    stdout.Write(buffer, 0, bytes);

                    capture.GetNextPacketSize(out packetFrames);
                }
                stdout.Flush();
            }
        }
        finally
        {
            client.Stop();
        }
    }

    static IntPtr AllocWaveFormat()
    {
        // WAVEFORMATEX, WAVE_FORMAT_PCM
        IntPtr p = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(p, 0, 1);
        Marshal.WriteInt16(p, 2, Channels);
        Marshal.WriteInt32(p, 4, SampleRate);
        Marshal.WriteInt32(p, 8, SampleRate * BlockAlign);
        Marshal.WriteInt16(p, 12, BlockAlign);
        Marshal.WriteInt16(p, 14, BitsPerSample);
        Marshal.WriteInt16(p, 16, 0);
        return p;
    }

    static IAudioClient ActivateProcessLoopback(uint excludePid)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK, { pid, EXCLUDE_TARGET_PROCESS_TREE } }
        IntPtr activationParams = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(activationParams, 0, 1);
        Marshal.WriteInt32(activationParams, 4, (int)excludePid);
        Marshal.WriteInt32(activationParams, 8, 1);

        // PROPVARIANT { VT_BLOB, BLOB { cbSize, pBlobData } }
        IntPtr propVariant = Marshal.AllocHGlobal(24);
        for (int i = 0; i < 24; i++) Marshal.WriteByte(propVariant, i, 0);
        Marshal.WriteInt16(propVariant, 0, 65);
        Marshal.WriteInt32(propVariant, 8, 12);
        Marshal.WriteIntPtr(propVariant, IntPtr.Size == 8 ? 16 : 12, activationParams);

        try
        {
            CompletionHandler handler = new CompletionHandler();
            IActivateAudioInterfaceAsyncOperation operation;
            ActivateAudioInterfaceAsync("VAD\\Process_Loopback", IID_IAudioClient, propVariant, handler, out operation);

            if (!handler.Done.WaitOne(5000)) throw new TimeoutException("audio interface activation timed out");

            int activateResult;
            object activated;
            operation.GetActivateResult(out activateResult, out activated);
            if (activateResult != 0) Marshal.ThrowExceptionForHR(activateResult);

            return (IAudioClient)activated;
        }
        finally
        {
            Marshal.FreeHGlobal(propVariant);
            Marshal.FreeHGlobal(activationParams);
        }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    // Must be agile (callback arrives on an arbitrary thread); managed CCWs
    // already aggregate the free-threaded marshaler, IAgileObject declares it.
    class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            Done.Set();
        }
    }
}

[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject { }

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
    void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
    void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    void Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
    void GetBufferSize(out uint numBufferFrames);
    void GetStreamLatency(out long hnsLatency);
    void GetCurrentPadding(out uint numPaddingFrames);
    void IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr ppClosestMatch);
    void GetMixFormat(out IntPtr ppDeviceFormat);
    void GetDevicePeriod(out long hnsDefaultDevicePeriod, out long hnsMinimumDevicePeriod);
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr eventHandle);
    void GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    void GetBuffer(out IntPtr ppData, out uint numFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
    void ReleaseBuffer(uint numFramesRead);
    void GetNextPacketSize(out uint numFramesInNextPacket);
}
