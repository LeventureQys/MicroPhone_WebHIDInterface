using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    // 一键启动器：双击本 exe 等价于带 --no-sandbox 启动同目录的 portable 包。
    // 为什么不在 Electron 主进程里补参数：本机 Chromium 沙箱在进入 JS 之前就崩了
    // （exit 0x80000003，main 一行都不执行），参数必须出现在进程启动命令行上。
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            // 优先当前发布版本的 payload；发布新版本时改这一行即可（找不到就退回目录里最新的包）
            string target = Path.Combine(dir, "MicStudio-1.1.3-portable.exe");
            if (!File.Exists(target))
            {
                string[] found = Directory.GetFiles(dir, "MicStudio-*-portable.exe");
                Array.Sort(found, StringComparer.OrdinalIgnoreCase);
                target = found.Length > 0 ? found[found.Length - 1] : null;
            }
            if (target == null)
            {
                return 2;
            }

            ProcessStartInfo info = new ProcessStartInfo(target);
            info.UseShellExecute = false;
            info.WorkingDirectory = dir;
            info.Arguments = "--no-sandbox" + (args.Length > 0 ? " " + JoinArguments(args) : "");
            Process.Start(info);
            return 0;
        }
        catch
        {
            return 1;
        }
    }

    private static string JoinArguments(string[] args)
    {
        string result = string.Empty;
        for (int index = 0; index < args.Length; index++)
        {
            if (index > 0)
            {
                result += " ";
            }
            result += "\"" + args[index].Replace("\"", "\\\"") + "\"";
        }
        return result;
    }
}
