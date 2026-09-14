# -*- coding: utf-8 -*-
"""Where a build reads from and writes to, and how it fails.

Audit S8. Both game builds used to name absolute paths -- Sojourner four of
them under /tmp, Word Chain an implicit cwd -- so neither produced a dist/ from
a clean checkout and neither could run in CI. This module is the answer to all
three halves of that:

  * `repo_root()` finds the checkout from the script's own location, so a build
    works whatever directory it is invoked from.
  * `resolve()` gives every path a repo-relative default that can be overridden
    by a command-line flag or an environment variable, in that order.
  * `MissingInput` is how a build says "this input cannot live in git, here is
    where to get it" -- one line a human can act on, never a traceback.

Standard library only.
"""

import argparse
import os
import sys

__all__ = ['repo_root', 'resolve', 'add_path_args', 'MissingInput',
           'require', 'require_dir', 'run']


# --------------------------------------------------------------------------- #
# the checkout

_MARKERS = ('packages/tokens/tokens.css', 'packages/ui/ui.css')


def _complete(d):
    return [m for m in _MARKERS if not os.path.exists(os.path.join(d, m))]


def repo_root(start=None):
    """The checkout root, identified by the files it must contain, not by .git.

    With no argument this is computed from THIS FILE's position -- paths.py
    always lives at <root>/packages/build/paths.py -- and not by searching. A
    search would walk past an incomplete checkout into whatever ancestor
    directory happens to hold a packages/ of its own, and then quietly inline a
    stranger's tokens.css. An incomplete checkout must say so instead.

    Passing `start` walks up from there, for a caller that is not in this tree.
    """
    if start is None:
        here = os.path.dirname(os.path.abspath(__file__))          # <root>/packages/build
        d = os.path.dirname(os.path.dirname(here))
        missing = _complete(d)
        if missing:
            raise MissingInput(
                'an incomplete checkout at %s' % d,
                'missing ' + ', '.join(missing),
                'packages/build lives at <root>/packages/build, so the root is two '
                'levels above it; these files must be there')
        return d
    d = os.path.abspath(start)
    while True:
        if not _complete(d):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise MissingInput(
                'the repository root',
                'walked up from %s and never found %s' % (start, ' and '.join(_MARKERS)),
                'run this from inside the checkout')
        d = parent


# --------------------------------------------------------------------------- #
# path resolution: flag, then environment, then repo-relative default

def resolve(default, cli=None, env=None):
    """Pick a path: the command-line value, else $env, else `default`.

    Always returns an absolute path with a trailing separator, because both
    builds concatenate onto it.
    """
    value = cli or (os.environ.get(env) if env else None) or default
    value = os.path.abspath(os.path.expanduser(value))
    return value + os.sep


def add_path_args(parser, src=True, build=True, dist=True):
    """The flags every build in this repo shares."""
    if src:
        parser.add_argument('--src', metavar='DIR',
                            help='hand-written sources (default: beside this script; $SRC)')
    if build:
        parser.add_argument('--build', metavar='DIR',
                            help='generated/downloaded build inputs (default: the game\'s '
                                 'data/ directory; $BUILD)')
    if dist:
        parser.add_argument('--dist', metavar='DIR',
                            help='output directory (default: the game\'s dist/; $DIST)')
    parser.add_argument('--check', action='store_true',
                        help='validate inputs and the output that would be written, '
                             'write nothing, exit non-zero on a problem')
    parser.add_argument('-q', '--quiet', action='store_true', help='only report problems')
    return parser


# --------------------------------------------------------------------------- #
# missing inputs

class MissingInput(Exception):
    """An input that cannot be committed is absent.

    The message names WHAT is missing, WHERE it was looked for, and WHERE TO GET
    IT. A build that dies on `FileNotFoundError: '/tmp/three/build/three.min.js'`
    tells the reader nothing they did not already know.
    """

    def __init__(self, what, where, hint=None):
        self.what, self.where, self.hint = what, where, hint
        msg = '%s: %s' % (what, where)
        if hint:
            msg += '\n    -> ' + hint.replace('\n', '\n       ')
        Exception.__init__(self, msg)


def require(path, what, hint=None):
    """Return `path` if it exists, else raise MissingInput."""
    if not os.path.exists(path):
        raise MissingInput(what, 'not found at %s' % path, hint)
    return path


def require_dir(path, what, hint=None):
    if not os.path.isdir(path):
        raise MissingInput(what, 'no such directory %s' % path, hint)
    return path


# --------------------------------------------------------------------------- #
# the wrapper every build main() goes through

def run(main, argv=None):
    """Call `main(args)`; turn MissingInput into a clear message, not a traceback.

    Exit codes:  0 fine   1 a check failed   2 an input is missing.
    """
    try:
        rc = main(argv)
    except MissingInput as e:
        sys.stderr.write('\n%s: missing build input\n  %s\n\n'
                         % (os.path.basename(sys.argv[0]), e))
        return 2
    return 0 if rc is None else rc
