#!/usr/bin/env python3

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


DEFAULT_FRAGMENT_PREAMBLE = r"""\def\pgfsysdriver{{pgfsys-dvisvgm.def}}
\documentclass[tikz,border={border}]{{standalone}}
\usepackage{{amsmath}}
\usepackage{{amssymb}}
\usepackage{{xcolor}}
\usepackage{{tikz}}
{preamble}
"""


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Compile LaTeX to DVI, then convert the DVI to a portable SVG.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  scripts/tex-to-svg.py site/images/figure.tex
  scripts/tex-to-svg.py site/images/figure.tex -o site/images/figure.svg
  scripts/tex-to-svg.py --code '\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}' -o site/images/circle.svg
  scripts/tex-to-svg.py --mode math --code '\\int_0^1 x^2\\,dx' -o site/images/integral.svg
  scripts/tex-to-svg.py --stdin -o site/images/from-stdin.svg < figure.tex
""",
    )

    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("tex_file", nargs="?", help="Path to a .tex file to compile as a full document")
    input_group.add_argument("--code", help="LaTeX document or fragment provided directly on the command line")
    input_group.add_argument("--stdin", action="store_true", help="Read LaTeX document or fragment from stdin")

    parser.add_argument("-o", "--output", help="Output SVG path. Defaults to TEX_FILE with a .svg suffix.")
    parser.add_argument(
        "--mode",
        choices=("auto", "document", "fragment", "math"),
        default="auto",
        help="How to treat --code/--stdin input. auto wraps input unless it contains \\documentclass. (default: auto)",
    )
    parser.add_argument("--border", default="2pt", help="standalone border for wrapped fragments (default: 2pt)")
    parser.add_argument(
        "--preamble",
        action="append",
        default=[],
        help="Extra preamble line for wrapped fragments. May be repeated.",
    )
    parser.add_argument(
        "--texinputs",
        action="append",
        default=[],
        metavar="DIR",
        help="Additional directory to add to TEXINPUTS. May be repeated.",
    )
    parser.add_argument(
        "--no-pgf-dvisvgm-driver",
        action="store_true",
        help="Do not preselect PGF's dvisvgm driver before compiling.",
    )
    parser.add_argument("--latex", default="latex", help="LaTeX executable (default: latex)")
    parser.add_argument("--dvisvgm", default="dvisvgm", help="dvisvgm executable (default: dvisvgm)")
    parser.add_argument(
        "--latex-option",
        action="append",
        default=[],
        help="Additional option passed to latex. May be repeated.",
    )
    parser.add_argument(
        "--dvisvgm-option",
        action="append",
        default=[],
        help="Additional option passed to dvisvgm. May be repeated.",
    )
    parser.add_argument("--precision", type=int, default=3, help="SVG coordinate precision, 0-6 (default: 3)")
    parser.add_argument("--keep-temp", action="store_true", help="Keep temporary build files for debugging")
    parser.add_argument("--verbose", action="store_true", help="Print latex and dvisvgm output")

    args = parser.parse_args(argv)

    if args.output is None and not args.tex_file:
        parser.error("--output is required when using --code or --stdin")
    if not 0 <= args.precision <= 6:
        parser.error("--precision must be between 0 and 6")

    return args


def make_env(extra_texinputs):
    env = os.environ.copy()
    if extra_texinputs:
        texinputs = [str(Path(path).resolve()) for path in extra_texinputs]
        existing = env.get("TEXINPUTS", "")
        # The trailing empty component preserves TeX's default search path.
        env["TEXINPUTS"] = os.pathsep.join(texinputs + [existing, ""])
    return env


def is_document(tex):
    return r"\documentclass" in tex


def wrap_fragment(tex, mode, border, preamble_lines):
    if mode == "document" or (mode == "auto" and is_document(tex)):
        return tex

    body = tex
    if mode == "math":
        body = rf"\(\displaystyle {tex}\)"

    preamble = "\n".join(preamble_lines)
    return (
        DEFAULT_FRAGMENT_PREAMBLE.format(border=border, preamble=preamble)
        + "\n\\begin{document}\n"
        + body
        + "\n\\end{document}\n"
    )


def command_text(command):
    return " ".join(str(part) for part in command)


def run_command(command, cwd, env, verbose):
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if verbose and result.stdout:
        print(result.stdout, end="")
    if result.returncode != 0:
        raise CommandError(command, result.returncode, result.stdout)
    return result.stdout


class CommandError(Exception):
    def __init__(self, command, returncode, output):
        super().__init__(f"{command_text(command)} exited with status {returncode}")
        self.command = command
        self.returncode = returncode
        self.output = output


def tail_text(text, lines=80):
    split = text.strip().splitlines()
    return "\n".join(split[-lines:])


def read_log_tail(log_path):
    try:
        return tail_text(log_path.read_text(errors="replace"))
    except FileNotFoundError:
        return ""


def tex_input_command(tex_name, use_pgf_dvisvgm_driver):
    if any(char in tex_name for char in "{}\n\r"):
        raise UserError(f"TeX input filename contains unsupported characters: {tex_name}")
    quoted_name = f'"{tex_name}"' if " " in tex_name else tex_name
    prefix = "" if not use_pgf_dvisvgm_driver else r"\def\pgfsysdriver{pgfsys-dvisvgm.def}"
    return prefix + rf"\input{{{quoted_name}}}"


def compile_to_dvi(args, tex_path, cwd, build_dir, env):
    jobname = "tex-to-svg"
    command = [
        args.latex,
        "-halt-on-error",
        "-interaction=nonstopmode",
        "-file-line-error",
        "-output-format=dvi",
        f"-output-directory={build_dir}",
        f"-jobname={jobname}",
        *args.latex_option,
        tex_input_command(str(tex_path), not args.no_pgf_dvisvgm_driver),
    ]
    try:
        run_command(command, cwd=cwd, env=env, verbose=args.verbose)
    except CommandError as error:
        log_tail = read_log_tail(build_dir / f"{jobname}.log") or tail_text(error.output)
        raise UserError(
            "latex failed while generating DVI.\n"
            f"Command: {command_text(error.command)}\n"
            f"Log tail:\n{log_tail}"
        ) from error

    dvi_path = build_dir / f"{jobname}.dvi"
    if not dvi_path.exists():
        raise UserError(f"latex completed but did not produce {dvi_path}")
    return dvi_path


def convert_dvi_to_svg(args, dvi_path, output_path, env, cwd):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        args.dvisvgm,
        "--no-fonts",
        "--exact-bbox",
        f"--precision={args.precision}",
        f"--output={output_path}",
        *args.dvisvgm_option,
        str(dvi_path),
    ]
    try:
        run_command(command, cwd=cwd, env=env, verbose=args.verbose)
    except CommandError as error:
        raise UserError(
            "dvisvgm failed while converting DVI to SVG.\n"
            f"Command: {command_text(error.command)}\n"
            f"Output:\n{tail_text(error.output)}"
        ) from error

    if not output_path.exists():
        raise UserError(f"dvisvgm completed but did not produce {output_path}")


def resolve_input(args, build_dir):
    if args.tex_file:
        tex_path = Path(args.tex_file).resolve()
        if not tex_path.exists():
            raise UserError(f"TeX file not found: {tex_path}")
        if not tex_path.is_file():
            raise UserError(f"TeX input is not a file: {tex_path}")
        output = Path(args.output).resolve() if args.output else tex_path.with_suffix(".svg")
        return tex_path.name, tex_path.parent, output

    tex = sys.stdin.read() if args.stdin else args.code
    tex_path = build_dir / "input.tex"
    tex_path.write_text(wrap_fragment(tex, args.mode, args.border, args.preamble))
    return tex_path.name, build_dir, Path(args.output).resolve()


class UserError(Exception):
    pass


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if shutil.which(args.latex) is None:
        raise UserError(f"latex executable not found: {args.latex}")
    if shutil.which(args.dvisvgm) is None:
        raise UserError(f"dvisvgm executable not found: {args.dvisvgm}")

    temp_root = tempfile.mkdtemp(prefix="tex-to-svg-")
    build_dir = Path(temp_root)
    try:
        tex_name, cwd, output_path = resolve_input(args, build_dir)
        env = make_env(args.texinputs)
        dvi_path = compile_to_dvi(args, tex_name, cwd, build_dir, env)
        convert_dvi_to_svg(args, dvi_path, output_path, env, cwd)
        print(f"{Path(cwd) / tex_name} -> {output_path}")
        if args.keep_temp:
            print(f"Temporary build files kept in {build_dir}")
    finally:
        if not args.keep_temp:
            shutil.rmtree(build_dir, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except UserError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
