// SPDX-License-Identifier: LGPL-3.0-or-later
using System;
using System.IO;
#if LINUX_COMPILER
using SkiaSharp;
#else
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;
#endif

namespace WF.Compiler
{
    internal static class JpegMedia
    {
        public static byte[] Convert(byte[] data, int maxWidth, bool noResize)
        {
#if LINUX_COMPILER
            using var source = SKBitmap.Decode(data)
                ?? throw new InvalidDataException("Could not decode cartridge image.");
            int width = noResize ? source.Width : Math.Min(source.Width, maxWidth);
            int height = ScaledHeight(source.Width, source.Height, width);
            using var bitmap = new SKBitmap(width, height, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(bitmap))
            {
                canvas.Clear(SKColors.Black);
                using var image = SKImage.FromBitmap(source);
                canvas.DrawImage(image, new SKRect(0, 0, width, height),
                    new SKSamplingOptions(SKCubicResampler.Mitchell));
            }
            using var encoded = bitmap.Encode(SKEncodedImageFormat.Jpeg, 90)
                ?? throw new InvalidDataException("Could not encode cartridge image as JPEG.");
            return encoded.ToArray();
#else
            using var input = new MemoryStream(data);
            using var source = Image.FromStream(input);
            using var original = new Bitmap(source);
            using var resized = !noResize && original.Width > maxWidth
                ? new Bitmap(maxWidth, ScaledHeight(original.Width, original.Height, maxWidth), PixelFormat.Format24bppRgb)
                : null;
            if (resized != null)
            {
                using var graphics = Graphics.FromImage(resized);
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(original, 0, 0, resized.Width, resized.Height);
            }

            var codec = ImageCodecInfo.GetImageEncoders().First(encoder => encoder.MimeType == "image/jpeg");
            using var parameters = new EncoderParameters(2);
            parameters.Param[0] = new EncoderParameter(Encoder.ColorDepth, 24L);
            parameters.Param[1] = new EncoderParameter(Encoder.Quality, 90L);
            using var output = new MemoryStream();
            (resized ?? original).Save(output, codec, parameters);
            return output.ToArray();
#endif
        }

        private static int ScaledHeight(int sourceWidth, int sourceHeight, int width)
        {
            return Math.Max(1, (int)((long)sourceHeight * width / sourceWidth));
        }
    }
}
