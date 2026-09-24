"""
Version utilities for Open Notebook.
Handles version comparison, GitHub version fetching, and package version management.
"""

from importlib.metadata import PackageNotFoundError, version
from urllib.parse import urlparse

import requests  # type: ignore
from packaging.version import parse as parse_version


async def get_version_from_github_async(repo_url: str, branch: str = "main") -> str:
    """
    Fetch the latest version from GitHub Releases API (async).
    More reliable than raw.githubusercontent.com for users in China.
    """
    from urllib.parse import urlparse

    import httpx

    # Parse the GitHub URL
    parsed_url = urlparse(repo_url)
    if "github.com" not in parsed_url.netloc:
        raise ValueError("Not a GitHub URL")

    # Extract owner and repo name from path
    path_parts = parsed_url.path.strip("/").split("/")
    if len(path_parts) < 2:
        raise ValueError("Invalid GitHub repository URL")

    owner, repo = path_parts[0], path_parts[1]

    # Use GitHub Releases API - more reliable than raw content
    api_url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"

    # Fetch with timeout using httpx
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(api_url)
        response.raise_for_status()
        release_data = response.json()

    # Extract version tag (e.g., "v1.14.0" -> "1.14.0")
    tag_name = release_data.get("tag_name", "")
    version_str = tag_name.lstrip("v")

    if not version_str:
        raise KeyError("Version tag not found in GitHub release")

    return version_str

def get_version_from_github(repo_url: str, branch: str = "main") -> str:
    """
    Fetch the latest version from GitHub Releases API.
    More reliable than raw.githubusercontent.com for users in China.

    Args:
        repo_url (str): URL of the GitHub repository
        branch (str): Branch name (not used for Releases API, kept for compatibility)

    Returns:
        str: Version string from GitHub release tag

    Raises:
        ValueError: If the URL is not a valid GitHub repository URL
        requests.RequestException: If there's an error fetching the release info
        KeyError: If version information is not found in GitHub release
    """
    # Parse the GitHub URL
    parsed_url = urlparse(repo_url)
    if "github.com" not in parsed_url.netloc:
        raise ValueError("Not a GitHub URL")

    # Extract owner and repo name from path
    path_parts = parsed_url.path.strip("/").split("/")
    if len(path_parts) < 2:
        raise ValueError("Invalid GitHub repository URL")

    owner, repo = path_parts[0], path_parts[1]

    # Use GitHub Releases API - more reliable than raw content
    api_url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"

    # Fetch with timeout
    response = requests.get(api_url, timeout=10)
    response.raise_for_status()
    release_data = response.json()

    # Extract version tag (e.g., "v1.14.0" -> "1.14.0")
    tag_name = release_data.get("tag_name", "")
    version_str = tag_name.lstrip("v")

    if not version_str:
        raise KeyError("Version tag not found in GitHub release")

    return version_str


def get_installed_version(package_name: str) -> str:
    """
    Get the version of an installed package.

    Args:
        package_name (str): Name of the installed package

    Returns:
        str: Version string of the installed package

    Raises:
        PackageNotFoundError: If the package is not installed
    """
    try:
        return version(package_name)
    except PackageNotFoundError:
        raise PackageNotFoundError(f"Package '{package_name}' not found")


def compare_versions(version1: str, version2: str) -> int:
    """
    Compare two semantic versions.

    Args:
        version1 (str): First version string
        version2 (str): Second version string

    Returns:
        int: -1 if version1 < version2
              0 if version1 == version2
              1 if version1 > version2
    """
    v1 = parse_version(version1)
    v2 = parse_version(version2)

    if v1 < v2:
        return -1
    elif v1 > v2:
        return 1
    else:
        return 0
